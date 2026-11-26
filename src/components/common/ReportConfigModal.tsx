import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  GripVertical,
  Printer,
  RotateCcw,
  X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { DEFAULT_PRINT_STYLE, type PrintStyleOptions } from '../../lib/reportBuilder'
import { Button } from '../ui/Button'

export interface ReportFieldItem {
  key: string
  enabled: boolean
}

export interface ReportFieldDef {
  key: string
  label: string
  description?: string
}

const FONT_SIZES = Array.from({ length: 22 }, (_, i) => i + 7) // 7px..28px

function CheckboxUI({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border transition ${
        checked
          ? 'border-brand-500 bg-brand-500 text-white'
            : 'border-line bg-white hover:border-brand-500'
      }`}
      aria-checked={checked}
      role="checkbox"
    >
      {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </button>
  )
}

interface ReportConfigModalProps {
  title: string
  open: boolean
  mode: 'print' | 'export'
  fieldDefs?: ReportFieldDef[]
  fields?: ReportFieldItem[]
  defaultFields?: ReportFieldItem[]
  showLayout?: boolean
  layout?: boolean
  layoutTrueLabel?: string
  layoutFalseLabel?: string
  fontSize?: number
  boldText?: boolean
  defaultFontSize?: number
  defaultBoldText?: boolean
  showHeaderDetails?: boolean
  exportBorders?: boolean
  exportRowHeight?: number
  exportColWidth?: number
  includePhotos?: boolean
  showIncludePhotos?: boolean
  extraControls?: ReactNode
  printDescription?: string
  printActionLabel?: string
  onClose: () => void
  onConfirm: (fields: ReportFieldItem[], layout: boolean, style: PrintStyleOptions) => void
  onDownloadPdf?: (fields: ReportFieldItem[], layout: boolean, style: PrintStyleOptions) => void
}

// Shared configuration modal for every print / Excel export section. The
// page supplies its field definitions and current selection (reordered here),
// plus any page-specific controls through the extraControls slot. Font size,
// bold text, and Excel border/row/column options are centralized so every
// section gets the same print/export configuration options.
export function ReportConfigModal({
  title,
  open,
  mode,
  fieldDefs,
  fields,
  defaultFields,
  showLayout = false,
  layout = true,
  layoutTrueLabel = 'Detailed',
  layoutFalseLabel = 'Heads only',
  fontSize = DEFAULT_PRINT_STYLE.fontSize,
  boldText = DEFAULT_PRINT_STYLE.boldText,
  defaultFontSize,
  defaultBoldText,
  showHeaderDetails = DEFAULT_PRINT_STYLE.showHeaderDetails,
  exportBorders = DEFAULT_PRINT_STYLE.exportBorders,
  exportRowHeight = DEFAULT_PRINT_STYLE.exportRowHeight,
  exportColWidth = DEFAULT_PRINT_STYLE.exportColWidth,
  includePhotos = DEFAULT_PRINT_STYLE.includePhotos,
  showIncludePhotos = false,
  extraControls,
  printDescription,
  printActionLabel = 'Print',
  onClose,
  onConfirm,
  onDownloadPdf,
}: ReportConfigModalProps) {
  const [workingFields, setWorkingFields] = useState<ReportFieldItem[]>(fields ?? [])
  const [workingLayout, setWorkingLayout] = useState(layout)
  const [workingFontSize, setWorkingFontSize] = useState(fontSize)
  const [workingBold, setWorkingBold] = useState(boldText)
  const [workingShowHeader, setWorkingShowHeader] = useState(showHeaderDetails ?? false)
  const [workingBorders, setWorkingBorders] = useState(exportBorders)
  const [workingRowHeight, setWorkingRowHeight] = useState(exportRowHeight)
  const [workingColWidth, setWorkingColWidth] = useState(exportColWidth)
  const [workingIncludePhotos, setWorkingIncludePhotos] = useState(includePhotos ?? false)
  const [showAll, setShowAll] = useState(false)

  // Tracks the previous open state so the working fields/layout are only
  // seeded when the modal actually opens, not on every parent re-render. The
  // `fields`/`layout`/style props are freshly allocated object/array
  // references on each render of the page, so including them directly in the
  // dependency array would reset the user's in-progress selection whenever
  // the page re-renders (e.g. photos still loading) while the modal is open.
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setWorkingFields((fields ?? []).map((f) => ({ ...f })))
      setWorkingLayout(layout)
      setWorkingFontSize(fontSize)
      setWorkingBold(boldText)
      setWorkingShowHeader(showHeaderDetails ?? false)
      setWorkingBorders(exportBorders)
      setWorkingRowHeight(exportRowHeight)
      setWorkingColWidth(exportColWidth)
      setWorkingIncludePhotos(includePhotos ?? false)
      setShowAll(false)
    }
    wasOpenRef.current = open
  }, [open, fields, layout, fontSize, boldText, showHeaderDetails, exportBorders, exportRowHeight, exportColWidth, includePhotos])

  if (!open) return null

  const defByKey = (key: string): ReportFieldDef | undefined =>
    fieldDefs?.find((d) => d.key === key)

  const toggle = (key: string) => {
    setWorkingFields((prev) => prev.map((f) => (f.key === key ? { ...f, enabled: !f.enabled } : f)))
  }

  const moveField = (key: string, dir: -1 | 1) => {
    setWorkingFields((prev) => {
      const idx = prev.findIndex((f) => f.key === key)
      const target = idx + dir
      if (idx < 0 || target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  const reset = () => {
    setWorkingFields((defaultFields ?? fields ?? []).map((f) => ({ ...f })))
    setWorkingLayout(true)
    setWorkingFontSize(defaultFontSize ?? DEFAULT_PRINT_STYLE.fontSize)
    setWorkingBold(defaultBoldText ?? DEFAULT_PRINT_STYLE.boldText)
    setWorkingShowHeader(DEFAULT_PRINT_STYLE.showHeaderDetails ?? false)
    setWorkingBorders(DEFAULT_PRINT_STYLE.exportBorders)
    setWorkingRowHeight(DEFAULT_PRINT_STYLE.exportRowHeight)
    setWorkingColWidth(DEFAULT_PRINT_STYLE.exportColWidth)
    setWorkingIncludePhotos(DEFAULT_PRINT_STYLE.includePhotos ?? false)
  }

  const buildResult = (): [ReportFieldItem[], boolean, PrintStyleOptions] | null => {
    if (workingFields.length && !workingFields.some((f) => f.enabled)) {
      toast.error('Enable at least one field to continue.')
      return null
    }
    return [
      workingFields.map((f) => ({ ...f })),
      workingLayout,
      {
        fontSize: workingFontSize,
        boldText: workingBold,
        showHeaderDetails: workingShowHeader,
        exportBorders: workingBorders,
        exportRowHeight: workingRowHeight,
        exportColWidth: workingColWidth,
        includePhotos: workingIncludePhotos,
      },
    ]
  }

  const handleConfirm = () => {
    const result = buildResult()
    if (result) onConfirm(...result)
  }

  const handleDownloadPdf = () => {
    const result = buildResult()
    if (result) onDownloadPdf?.(...result)
  }

  const enabledCount = workingFields.filter((f) => f.enabled).length
  const visibleList = showAll ? workingFields : workingFields.filter((f) => f.enabled)
  const hasFields = Boolean(fieldDefs && fields)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-popover">
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <h3 className="text-lg font-semibold text-ink">
              {mode === 'print' ? `Print or download ${title}` : `Export ${title} to Excel`}
            </h3>
            <p className="mt-1 text-xs text-ink-tertiary">
              {mode === 'print'
                ? (printDescription ?? 'Choose columns and layout, then print or download a PDF.')
                : 'Choose what to include and the column order for the Excel export.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        <div className="border-b border-line bg-muted/70 px-6 py-3 text-xs">
          {showLayout && (
            <div className="mb-3">
              <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Layout</label>
              <select
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={workingLayout ? 'detailed' : 'headsOnly'}
                onChange={(e) => setWorkingLayout(e.target.value === 'detailed')}
              >
                <option value="detailed">{layoutTrueLabel}</option>
                <option value="headsOnly">{layoutFalseLabel}</option>
              </select>
            </div>
          )}

          {mode === 'print' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Font Size</label>
                  <div className="flex gap-2">
                    <select
                      className="h-9 flex-1 rounded-lg border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                      value={FONT_SIZES.includes(workingFontSize) ? workingFontSize : ''}
                      onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setWorkingFontSize(v) }}
                    >
                      {FONT_SIZES.map((size) => (
                        <option key={size} value={size}>{size}px</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={7}
                      max={28}
                      title="Custom font size (7-28px)"
                      className="h-9 w-20 rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                      value={workingFontSize}
                      onChange={(e) => setWorkingFontSize(Math.max(7, Math.min(28, Number(e.target.value) || 11)))}
                    />
                  </div>
                </div>
                <label className="flex h-9 cursor-pointer select-none items-center gap-2 self-end rounded-lg border border-line bg-white px-3 text-sm text-ink-secondary transition hover:bg-muted">
                  <CheckboxUI checked={workingBold} onChange={() => setWorkingBold((v) => !v)} />
                  <span className="font-medium">Bold text</span>
                </label>
              </div>
              <label className="flex h-9 cursor-pointer select-none items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm text-ink-secondary transition hover:bg-muted">
                <CheckboxUI checked={workingShowHeader} onChange={() => setWorkingShowHeader((v) => !v)} />
                <span className="font-medium">Show Header Details</span>
              </label>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex h-9 cursor-pointer select-none items-center gap-2 self-end rounded-lg border border-line bg-white px-3 text-sm text-ink-secondary transition hover:bg-muted">
                  <CheckboxUI checked={workingBorders} onChange={() => setWorkingBorders((v) => !v)} />
                  <span className="font-medium">Cell borders</span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Row Ht</label>
                    <input
                      type="number"
                      min={0}
                      max={120}
                      className="h-9 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                      value={workingRowHeight}
                      onChange={(e) => setWorkingRowHeight(Math.max(0, Math.min(120, Number(e.target.value) || 0)))}
                      title="Row height in points (0 = auto)"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Col Wd</label>
                    <input
                      type="number"
                      min={8}
                      max={80}
                      className="h-9 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                      value={workingColWidth}
                      onChange={(e) => setWorkingColWidth(Math.max(8, Math.min(80, Number(e.target.value) || 8)))}
                      title="Column width in characters"
                    />
                  </div>
                </div>
              </div>
              {showIncludePhotos ? (
                <label className="flex cursor-pointer select-none items-start gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-secondary transition hover:bg-muted">
                  <span className="mt-0.5">
                    <CheckboxUI checked={workingIncludePhotos} onChange={() => setWorkingIncludePhotos((v) => !v)} />
                  </span>
                  <span>
                    <span className="font-medium">Include photos</span>
                    <span className="mt-0.5 block text-[11px] font-normal text-ink-tertiary">Embeds voter images in Excel. Large lists are slower and files get much bigger.</span>
                  </span>
                </label>
              ) : null}
            </div>
          )}

          {extraControls || null}
        </div>

        {hasFields && (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-line bg-muted/70 px-6 py-3 text-xs">
              <div className="flex items-center gap-3 text-ink-secondary">
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-brand-50 px-3 font-semibold text-brand-700">
                  <Check className="h-3.5 w-3.5" /> {enabledCount} selected
                </span>
                <span className="text-ink-tertiary">of {workingFields.length} fields</span>
              </div>
              <button type="button" onClick={() => setShowAll((v) => !v)} className="inline-flex h-7 items-center rounded-lg border border-line bg-white px-2.5 font-semibold text-ink-secondary transition hover:bg-muted">
                {showAll ? 'Show selected only' : 'Show all fields'}
              </button>
            </div>

            <div className="max-h-[40vh] flex-1 space-y-1 overflow-y-auto px-6 py-4">
              {visibleList.map((f) => {
                const def = defByKey(f.key)
                const idx = workingFields.findIndex((x) => x.key === f.key)
                return (
                  <div key={f.key} className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-3 py-2.5">
                    <GripVertical className="h-4 w-4 flex-shrink-0 text-ink-tertiary" />
                    <CheckboxUI checked={f.enabled} onChange={() => toggle(f.key)} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{def?.label ?? f.key}</p>
                      {def?.description ? <p className="text-[11px] text-ink-tertiary">{def.description}</p> : null}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <button type="button" onClick={() => moveField(f.key, -1)} disabled={idx <= 0} className="inline-flex h-6 w-7 items-center justify-center rounded-md border border-line text-ink-tertiary transition hover:bg-muted disabled:opacity-40" aria-label="Move up">
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => moveField(f.key, 1)} disabled={idx >= workingFields.length - 1} className="inline-flex h-6 w-7 items-center justify-center rounded-md border border-line text-ink-tertiary transition hover:bg-muted disabled:opacity-40" aria-label="Move down">
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
          <div className="flex items-center gap-2">
            {hasFields ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setWorkingFields((prev) => prev.map((f) => ({ ...f, enabled: true })))
                  setShowAll(true)
                }}
              >
                <Check className="h-4 w-4" /> Select all columns
              </Button>
            ) : null}
            <Button variant="secondary" onClick={reset}>
              <RotateCcw className="h-4 w-4" /> Reset
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            {onDownloadPdf ? (
              <Button variant="secondary" onClick={handleDownloadPdf}>
                <Download className="h-4 w-4" /> Download PDF
              </Button>
            ) : null}
            <Button onClick={handleConfirm}>
              {mode === 'print' ? <><Printer className="h-4 w-4" /> {printActionLabel}</> : <><Download className="h-4 w-4" /> Export Excel</>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
