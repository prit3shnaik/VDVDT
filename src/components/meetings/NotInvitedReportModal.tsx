import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import toast from 'react-hot-toast'
import type { Meeting, Voter } from '../../lib/types'
import { exportWorkbookToExcel, type PrintStyleOptions } from '../../lib/reportBuilder'
import { usePersistentState } from '../../hooks/usePersistentState'
import {
  DEFAULT_REPORT_FIELD_KEYS,
  GROUP_BY_OPTIONS,
  REPORT_FIELD_OPTIONS,
  defaultReportFields,
  groupReportRows,
  reportRowCellValue,
  type GroupByValue,
  type ReportFieldKey,
  type ReportRow,
} from '../../lib/meetingReport'
import type { FamilyGroup } from '../../lib/searchUtils'
import { usePhotoUrls } from '../../hooks/usePhotoUrls'

interface PartScopeOption {
  value: string
  label: string
}

interface NotInvitedReportModalProps {
  mode: 'export' | 'print' | null
  onClose: () => void
  meeting: Meeting | null
  coverageFamilies: FamilyGroup[]
  epicToVoter: Map<string, Voter>
  partScopeOptions?: PartScopeOption[]
  fixedPartScope?: string
  headingOverride?: string
  selectedVoterIds?: Set<string>
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function NotInvitedReportModal({
  mode,
  onClose,
  meeting,
  coverageFamilies,
  epicToVoter,
  partScopeOptions,
  fixedPartScope,
  headingOverride,
  selectedVoterIds,
}: NotInvitedReportModalProps) {
  const [partScope, setPartScope] = useState(fixedPartScope ?? 'all')
  const [scope, setScope] = useState<'heads' | 'members'>('members')
  const [groupBy, setGroupBy] = useState<GroupByValue>('family')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [reportFields, setReportFields] = useState<Record<ReportFieldKey, boolean>>(defaultReportFields())
  const [reportFieldOrder, setReportFieldOrder] = useState<ReportFieldKey[]>([...DEFAULT_REPORT_FIELD_KEYS])
  const [reportPaperSize, setReportPaperSize] = useState<'a4' | 'letter'>('a4')
  const [reportOrientation, setReportOrientation] = useState<'portrait' | 'landscape'>('landscape')
  const [reportPhotoSize, setReportPhotoSize] = useState<'small' | 'medium' | 'large'>('small')
  const [reportHeaderConstituency, setReportHeaderConstituency] = useState('')
  const [reportHeaderSignature, setReportHeaderSignature] = useState(false)
  const [fontSize, setFontSize] = usePersistentState<number>('vote:not-invited:printFontSize:v2', 20)
  const [boldText, setBoldText] = usePersistentState<boolean>('vote:not-invited:printBold', false)
  const [exportBorders, setExportBorders] = usePersistentState<boolean>('vote:not-invited:exportBorders', true)
  const [exportRowHeight, setExportRowHeight] = usePersistentState<number>('vote:not-invited:exportRowHeight', 18)
  const [exportColWidth, setExportColWidth] = usePersistentState<number>('vote:not-invited:exportColWidth', 16)

  useEffect(() => {
    if (mode != null) {
      setPartScope(fixedPartScope ?? 'all')
      setScope('members')
      setGroupBy('family')
      setSelectedOnly(selectedVoterIds != null && selectedVoterIds.size > 0)
      setReportFields(defaultReportFields())
      setReportFieldOrder([...DEFAULT_REPORT_FIELD_KEYS])
      setReportPaperSize('a4')
      setReportOrientation('landscape')
      setReportPhotoSize('small')
      setReportHeaderConstituency('')
      setReportHeaderSignature(false)
    }
  }, [mode, fixedPartScope, selectedVoterIds])

  const partLabel = fixedPartScope !== undefined
    ? (fixedPartScope || 'Unassigned')
    : partScope === 'all' ? 'All' : (partScope || 'Unassigned')

  const hasSelection = selectedVoterIds != null && selectedVoterIds.size > 0

  const sourceFamilies = useMemo(() => {
    if (fixedPartScope !== undefined) {
      return coverageFamilies.filter((f) => String(f.headVoter?.part_no ?? '') === fixedPartScope)
    }
    if (partScope === 'all') return coverageFamilies
    return coverageFamilies.filter((f) => String(f.headVoter?.part_no ?? '') === partScope)
  }, [coverageFamilies, partScope, fixedPartScope])

  const reportFamilies: FamilyGroup[] = useMemo(() => {
    if (!selectedOnly || !selectedVoterIds || selectedVoterIds.size === 0) return sourceFamilies
    const out: FamilyGroup[] = []
    for (const family of sourceFamilies) {
      const members = family.members.filter((m) => selectedVoterIds.has(m.id))
      if (!members.length) continue
      out.push({
        ...family,
        members,
        headVoter: family.headVoter && selectedVoterIds.has(family.headVoter.id) ? family.headVoter : null,
      })
    }
    return out
  }, [sourceFamilies, selectedOnly, selectedVoterIds])

  const headCount = reportFamilies.filter((f) => f.headVoter).length
  const memberCount = reportFamilies.reduce((sum, f) => sum + f.members.length, 0)

  const rows: ReportRow[] = useMemo(() => {
    const out: ReportRow[] = []
    for (const family of reportFamilies) {
      const members = scope === 'heads' ? (family.headVoter ? [family.headVoter] : []) : family.members
      for (const voter of members) out.push({ invitee: null, voter })
    }
    return out
  }, [reportFamilies, scope])

  const selectedReportKeys = useMemo(() => {
    const activeKeys = REPORT_FIELD_OPTIONS.filter((option) => reportFields[option.key]).map((option) => option.key)
    const ordered = reportFieldOrder.filter((key) => activeKeys.includes(key))
    for (const key of activeKeys) if (!ordered.includes(key)) ordered.push(key)
    return ordered
  }, [reportFieldOrder, reportFields])

  const photoPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const row of rows) if (row.voter?.photo_url) paths.add(row.voter.photo_url)
    return Array.from(paths)
  }, [rows])

  const photoUrlByPath = usePhotoUrls(photoPaths, mode != null)

  const resolvePhotoUrl = (voter: Voter | null | undefined): string => {
    if (!voter?.photo_url) return ''
    return photoUrlByPath[voter.photo_url] ?? ''
  }

  const handleExportExcel = (style: PrintStyleOptions) => {
    if (!selectedReportKeys.length) { toast.error('Select at least one field to export.'); return }
    const grouped = groupReportRows(rows, groupBy, epicToVoter)
    const headerLabels = selectedReportKeys.map((key) => REPORT_FIELD_OPTIONS.find((o) => o.key === key)!.label)
    const sheetRows: Array<Array<string | number>> = []
    for (const [groupLabel, groupRows] of grouped) {
      if (groupLabel) sheetRows.push([groupLabel])
      sheetRows.push(headerLabels)
      groupRows.forEach((row, index) => {
        const photoUrl = resolvePhotoUrl(row.voter)
        sheetRows.push(selectedReportKeys.map((key) => reportRowCellValue(row, key, index + 1, photoUrl)))
      })
      sheetRows.push([])
    }
    const colWidths = selectedReportKeys.map((key) => ({ wch: key === 'photo' ? 35 : key === 'name' ? 28 : 16 }))
    const partSuffix = fixedPartScope !== undefined ? `-part-${fixedPartScope || 'unassigned'}` : ''
    const selectionSuffix = selectedOnly && hasSelection ? '-selected' : ''
    const meetingSuffix = meeting?.id ? `-${meeting.id.slice(0, 8)}` : ''
    void exportWorkbookToExcel(
      [{ name: 'Not Yet Invited', rows: sheetRows, colWidths }],
      `not-invited${partSuffix}${selectionSuffix}${meetingSuffix}.xlsx`,
      style,
    )
    onClose()
  }

  const handlePrint = (style: PrintStyleOptions) => {
    if (!selectedReportKeys.length) { toast.error('Select at least one field to print.'); return }
    const fontSizePx = style.fontSize
    const bold = style.boldText
    const grouped = groupReportRows(rows, groupBy, epicToVoter)
    const headerLabels = selectedReportKeys.map((key) => REPORT_FIELD_OPTIONS.find((o) => o.key === key)!.label)
    const basePhoto = reportPhotoSize === 'large' ? 60 : reportPhotoSize === 'medium' ? 40 : 30
    const photoSizePx = `${Math.round(basePhoto * (fontSizePx / 11))}px`
    const pageWidth = reportPaperSize === 'a4' ? '210mm' : '215.9mm'
    const pageHeight = reportPaperSize === 'a4' ? '297mm' : '279.4mm'
    const pageSizeStyle = reportOrientation === 'landscape' ? `${pageHeight} ${pageWidth}` : `${pageWidth} ${pageHeight}`
    const reportHeading = headingOverride ?? meeting?.title ?? 'Not Yet Invited'
    const renderHeader = () => `
      <div class="print-header">
        <h1>Not Yet Invited Families Report</h1>
        ${reportHeaderConstituency ? `<div class="constituency">${escapeHtml(reportHeaderConstituency)}</div>` : ''}
        <div class="meta">
          ${escapeHtml(reportHeading)}
          ${meeting ? `&middot; Date: ${escapeHtml(meeting.meeting_date ?? '-')}` : ''}
          &middot; Part ${escapeHtml(partLabel)}
          ${selectedOnly && hasSelection ? `&middot; Selected voters only (${rows.length})` : ''}
          ${groupBy !== 'none' ? ` &middot; Grouped by ${GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label}` : ''}
          &middot; ${scope === 'heads' ? 'Family heads only' : 'Family heads + all members'}
          &middot; Generated ${new Date().toLocaleString()}
        </div>
        ${reportHeaderSignature ? '<div class="signature-line">Verified by: ________________________ &nbsp;&nbsp; Date: ________</div>' : ''}
      </div>`
    let bodyHtml = ''
    for (const [groupLabel, groupRows] of grouped) {
      if (groupLabel) bodyHtml += `<h2 class="group-title">${escapeHtml(groupLabel)}</h2>`
      bodyHtml += `<table><thead><tr>${headerLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>`
      groupRows.forEach((row, index) => {
        const photoUrl = resolvePhotoUrl(row.voter)
        const cells = selectedReportKeys.map((key) => {
          if (key === 'photo') return `<td>${photoUrl ? `<img class="photo" src="${escapeHtml(photoUrl)}" />` : ''}</td>`
          return `<td>${escapeHtml(reportRowCellValue(row, key, index + 1, photoUrl))}</td>`
        }).join('')
        bodyHtml += `<tr>${cells}</tr>`
      })
      bodyHtml += '</tbody></table>'
    }
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Not Yet Invited Families Report</title>
<style>
  @page { size: ${pageSizeStyle}; margin: 15mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 16px; }
  .print-header { margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #333; }
  .print-header h1 { font-size: 20px; margin: 0 0 4px; }
  .constituency { font-size: 14px; font-weight: 600; color: #444; margin-bottom: 4px; }
  .meta { font-size: 12px; color: #555; margin-bottom: 8px; }
  .signature-line { font-size: 13px; color: #333; margin-top: 8px; padding-top: 12px; border-top: 1px dashed #999; }
  .group-title { font-size: 15px; margin: 24px 0 8px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: ${fontSizePx}px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { background: #f0f0f0; }
  ${bold ? 'th, td { font-weight: 700; }' : ''}
  .photo { width: ${photoSizePx}; height: ${photoSizePx}; object-fit: cover; border-radius: 50%; }
  @media print {
    tr { break-inside: avoid; }
    .group-title { break-after: avoid; }
  }
</style>
</head>
<body>
  ${renderHeader()}
  ${bodyHtml}
</body>
</html>`
    const printWindow = window.open('', '_blank')
    if (!printWindow) { toast.error('Popup blocked. Please allow popups for this site to print.'); return }
    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 350)
    onClose()
  }

  if (mode == null) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-ink">
            {mode === 'export' ? 'Export not yet invited families to Excel' : 'Print not yet invited families report'}
          </h3>
          <button
            type="button"
            className="text-ink-tertiary hover:text-ink-secondary"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {headingOverride ? (
          <p className="mb-3 text-sm font-semibold text-ink-secondary">{headingOverride}</p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {fixedPartScope === undefined ? (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Not invited scope</label>
              <select
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={partScope}
                onChange={(e) => setPartScope(e.target.value)}
              >
                {(partScopeOptions && partScopeOptions.length ? partScopeOptions : [
                  { value: 'all', label: `All not-yet-invited parts (${coverageFamilies.length} families)` },
                ]).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Not invited scope</label>
              <p className="rounded-xl border border-line bg-muted px-3 py-2.5 text-sm font-semibold text-ink-secondary">
                Part {fixedPartScope || 'Unassigned'} ({selectedOnly && hasSelection ? `${reportFamilies.length} selected famil${reportFamilies.length === 1 ? 'y' : 'ies'}` : `${sourceFamilies.length} famil${sourceFamilies.length === 1 ? 'y' : 'ies'}`})
              </p>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Export scope</label>
            <select
              className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={selectedOnly ? 'selected' : 'all'}
              onChange={(e) => setSelectedOnly(e.target.value === 'selected')}
            >
              <option value="all">All not-yet-invited in scope</option>
              <option value="selected" disabled={!hasSelection}>
                Only selected voters ({selectedVoterIds?.size ?? 0})
              </option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Rows to export</label>
            <select
              className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={scope}
              onChange={(e) => setScope(e.target.value as 'heads' | 'members')}
            >
              <option value="members">Family head + all members ({memberCount} voters)</option>
              <option value="heads">Family head only ({headCount} voters)</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Group by</label>
            <select
              className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupByValue)}
            >
              {GROUP_BY_OPTIONS.map((o) => (
                o.value === 'status' ? null : <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Family-wise rows</label>
            <p className="rounded-xl border border-line bg-muted px-3 py-2.5 text-sm text-ink-secondary">
              {rows.length.toLocaleString()} voter{rows.length === 1 ? '' : 's'} in {reportFamilies.length.toLocaleString()} famil{reportFamilies.length === 1 ? 'y' : 'ies'}
            </p>
          </div>
        </div>

        {groupBy === 'family' ? (
          <p className="mt-2 text-xs text-ink-tertiary">
            Groups voters under their family head, so a family's members stay together in one section - include the "Section" field below to see each member's section too.
          </p>
        ) : null}

        <p className="mt-3 text-xs text-ink-tertiary">
          {selectedOnly && hasSelection
            ? `Exports only the ${rows.length.toLocaleString()} voter(s) you selected on the page.`
            : headingOverride
              ? 'Exports families where no member has been invited to any meeting.'
              : 'Exports families that have no invited members in this meeting.'} Choose "Family head only" for a compact head-wise list, or "Family head + all members" for every voter in those families.
        </p>

        {mode === 'print' ? (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Paper size</label>
              <select
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={reportPaperSize}
                onChange={(e) => setReportPaperSize(e.target.value as 'a4' | 'letter')}
              >
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Orientation</label>
              <select
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={reportOrientation}
                onChange={(e) => setReportOrientation(e.target.value as 'portrait' | 'landscape')}
              >
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </div>
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Photo size</label>
            <select
              className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              value={reportPhotoSize}
              onChange={(e) => setReportPhotoSize(e.target.value as 'small' | 'medium' | 'large')}
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Constituency header (optional)</label>
            <input
              className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              placeholder="e.g. 24 - Margao"
              value={reportHeaderConstituency}
              onChange={(e) => setReportHeaderConstituency(e.target.value)}
            />
          </div>
        </div>

        {mode === 'print' ? (
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
            <input type="checkbox" checked={reportHeaderSignature} onChange={(e) => setReportHeaderSignature(e.target.checked)} />
            Add signature / verification line
          </label>
        ) : null}

        <div className="mt-5">
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Fields to include (use arrows to reorder)</label>
          <div className="space-y-1">
            {reportFieldOrder.map((key, index) => {
              const option = REPORT_FIELD_OPTIONS.find((o) => o.key === key)
              if (!option) return null
              return (
                <div key={key} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      disabled={index === 0}
                      className="text-xs text-ink-tertiary hover:text-ink-secondary disabled:opacity-30"
                      onClick={() => setReportFieldOrder((prev) => { const next = [...prev]; const t = next[index - 1]; next[index - 1] = next[index]; next[index] = t; return next })}
                    >▲</button>
                    <button
                      type="button"
                      disabled={index === reportFieldOrder.length - 1}
                      className="text-xs text-ink-tertiary hover:text-ink-secondary disabled:opacity-30"
                      onClick={() => setReportFieldOrder((prev) => { const next = [...prev]; const t = next[index + 1]; next[index + 1] = next[index]; next[index] = t; return next })}
                    >▼</button>
                  </div>
                  <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={reportFields[option.key]}
                      onChange={() => setReportFields((current) => ({ ...current, [option.key]: !current[option.key] }))}
                    />
                    {option.label}
                  </label>
                </div>
              )
            })}
            {REPORT_FIELD_OPTIONS.filter((o) => !reportFieldOrder.includes(o.key)).map((option) => (
              <div key={option.key} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                <div className="flex flex-col gap-0.5">
                  <button type="button" disabled className="text-xs text-ink-tertiary">▲</button>
                  <button type="button" disabled className="text-xs text-ink-tertiary">▼</button>
                </div>
                <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                  <input type="checkbox" checked={false} onChange={() => setReportFields((current) => ({ ...current, [option.key]: true }))} />
                  {option.label}
                </label>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-3 text-xs font-semibold text-ink-tertiary">
            <button type="button" className="hover:text-ink-secondary" onClick={() => { setReportFields(defaultReportFields()); setReportFieldOrder([...DEFAULT_REPORT_FIELD_KEYS]) }}>
              Reset to default
            </button>
            <button
              type="button"
              className="hover:text-ink-secondary"
              onClick={() => {
                const all = {} as Record<ReportFieldKey, boolean>
                const order: ReportFieldKey[] = []
                for (const option of REPORT_FIELD_OPTIONS) { all[option.key] = true; order.push(option.key) }
                setReportFields(all)
                setReportFieldOrder(order)
              }}
            >
              Select all
            </button>
            <button
              type="button"
              className="hover:text-ink-secondary"
              onClick={() => {
                const none = {} as Record<ReportFieldKey, boolean>
                for (const option of REPORT_FIELD_OPTIONS) none[option.key] = false
                setReportFields(none)
              }}
            >
              Clear all
            </button>
          </div>
        </div>

        {mode === 'print' ? (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Font size</label>
              <select
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              >
                {Array.from({ length: 22 }, (_, i) => i + 7).map((size) => (
                  <option key={size} value={size}>{size}px</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Bold text</label>
              <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm text-ink-secondary">
                <input type="checkbox" checked={boldText} onChange={(e) => setBoldText(e.target.checked)} />
                Print in bold
              </label>
            </div>
          </div>
        ) : (
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Cell borders</label>
              <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm text-ink-secondary">
                <input type="checkbox" checked={exportBorders} onChange={(e) => setExportBorders(e.target.checked)} />
                Borders
              </label>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Row height</label>
              <input
                type="number"
                min={0}
                max={120}
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={exportRowHeight}
                onChange={(e) => setExportRowHeight(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Column width</label>
              <input
                type="number"
                min={8}
                max={80}
                className="h-10 w-full rounded-xl border border-line bg-white px-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                value={exportColWidth}
                onChange={(e) => setExportColWidth(Number(e.target.value))}
              />
            </div>
          </div>
        )}

        {mode === 'export' ? (
          <p className="mt-4 text-xs text-ink-tertiary">
            Photos export as a temporary link (valid ~1 hour), not an embedded image thumbnail - the current Excel library doesn't support embedding images.
          </p>
        ) : (
          <p className="mt-4 text-xs text-ink-tertiary">
            Opens a print-ready page in a new tab with the selected fields and grouping, then triggers your browser's print dialog - use "Save as PDF" there if you want a PDF instead of a physical printout.
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="h-11 rounded-2xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="h-11 rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700"
            onClick={() => {
              const style: PrintStyleOptions = {
                fontSize,
                boldText,
                exportBorders,
                exportRowHeight,
                exportColWidth,
              }
              if (mode === 'export') handleExportExcel(style)
              else handlePrint(style)
            }}
          >
            {mode === 'export' ? 'Export Excel file' : 'Print'}
          </button>
        </div>
      </div>
    </div>
  )
}
