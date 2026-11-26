import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'

export interface ReportFieldDef<T = unknown> {
  key: string
  label: string
  getValue: (row: T, context?: Record<string, unknown>) => string
}

export interface PrintStyleOptions {
  fontSize: number
  boldText: boolean
  exportBorders: boolean
  exportRowHeight: number
  exportColWidth: number
  /** When false, metadata fields in the print / PDF header are hidden. The team header name always remains visible. */
  showHeaderDetails?: boolean
  /** When true, Excel export embeds voter photos. Default off because large lists get slow and files get huge. */
  includePhotos?: boolean
  /** When true, each group title and its table stay together on one printed page. */
  keepGroupTogether?: boolean
}

export const DEFAULT_PRINT_STYLE: PrintStyleOptions = {
  fontSize: 20,
  boldText: false,
  exportBorders: true,
  exportRowHeight: 18,
  exportColWidth: 16,
  showHeaderDetails: false,
  includePhotos: false,
}

export interface ReportGroupResolver<T = unknown> {
  groupBy: string | null
  resolve: (row: T) => string
}

export interface ExcelExportConfig<T = unknown> {
  rows: T[]
  fields: ReportFieldDef<T>[]
  fileName: string
  title: string
  meta?: string
  groupBy?: ReportGroupResolver<T>
  layout?: { type: 'flat' | 'grouped' }
  /** When true, writes the title and meta lines above the table. */
  showMeta?: boolean
}

export interface PrintConfig<T = unknown> {
  rows: T[]
  fields: ReportFieldDef<T>[]
  title: string
  meta?: string
  groupBy?: ReportGroupResolver<T>
  photoResolver?: (row: T) => string
  footer?: string
}

export interface PdfTableDownloadOptions {
  title: string
  summary: Array<[string, string]>
  headers: string[]
  rows: string[][]
  /** Field key per column. Cells in the column keyed `photo` hold an image URL. */
  fieldKeys?: string[]
  /** When true, the summary/metadata block is omitted. The title (team header name) is always shown. */
  hideHeader?: boolean
  fontSize: number
  boldText: boolean
  fileName: string
}

interface LoadedPdfImage {
  dataUrl: string
  width: number
  height: number
}

const PDF_MARGIN = 28
const PDF_PHOTO_BOX = 38
const PDF_PHOTO_SOURCE_MAX = 160
const PDF_IMAGE_CONCURRENCY = 8

// Photos are re-encoded to JPEG through a canvas so unsupported source formats
// (webp) still embed, and so full-resolution portraits don't bloat the file.
async function loadPdfImage(url: string): Promise<LoadedPdfImage | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(PDF_PHOTO_SOURCE_MAX / bitmap.width, PDF_PHOTO_SOURCE_MAX / bitmap.height, 1)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.82), width, height }
  } catch {
    return null
  }
}

async function loadPdfImages(urls: string[]): Promise<Map<string, LoadedPdfImage>> {
  const loaded = new Map<string, LoadedPdfImage>()
  const unique = Array.from(new Set(urls.filter(Boolean)))
  for (let i = 0; i < unique.length; i += PDF_IMAGE_CONCURRENCY) {
    const batch = unique.slice(i, i + PDF_IMAGE_CONCURRENCY)
    const results = await Promise.all(batch.map(async (url) => [url, await loadPdfImage(url)] as const))
    for (const [url, image] of results) {
      if (image) loaded.set(url, image)
    }
  }
  return loaded
}

/** Downloads a paginated landscape PDF table with embedded photos. */
export async function downloadPdfTable(options: PdfTableDownloadOptions): Promise<void> {
  const blob = await buildPdfTable(options)
  saveBlob(blob, options.fileName)
}

// Triggers a browser download for an in-memory Blob. Kept small so callers
// that already hold a Blob (e.g. multi-PDF ZIP exports) reuse one path.
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Builds a paginated landscape PDF table with embedded photos and returns the
 * resulting file as a Blob without triggering a download. The filename is
 * ignored here - the caller decides how to consume the Blob (save it directly
 * or bundle it, e.g. into a ZIP).
 */
export async function buildPdfTable(options: PdfTableDownloadOptions): Promise<Blob> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const autoTable = autoTableModule.default

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const fontSize = Math.max(6, Math.min(16, options.fontSize))
  const photoIndex = options.fieldKeys?.findIndex((key) => key === 'photo') ?? -1

  const images = photoIndex >= 0
    ? await loadPdfImages(options.rows.map((row) => row[photoIndex] ?? ''))
    : new Map<string, LoadedPdfImage>()

  doc.setFontSize(9)
  const summaryLines = options.summary.length
    ? (doc.splitTextToSize(
        options.summary.map(([label, value]) => `${label}: ${value}`).join('   |   '),
        pageWidth - PDF_MARGIN * 2,
      ) as string[])
    : []

  const hideSummary = options.hideHeader === true
  const titleBaseline = PDF_MARGIN + 12
  const summaryTop = titleBaseline + 14
  const firstPageStartY = hideSummary || summaryLines.length === 0
    ? titleBaseline + 10
    : summaryTop + summaryLines.length * 11 + 6
  const tableTopMargin = titleBaseline + 10

  // The photo column holds URLs, which must never be printed as text.
  const body = options.rows.map((row) => row.map((value, index) => (index === photoIndex ? '' : value)))

  autoTable(doc, {
    head: [options.headers],
    body,
    startY: firstPageStartY,
    margin: { top: tableTopMargin, right: PDF_MARGIN, bottom: PDF_MARGIN + 8, left: PDF_MARGIN },
    tableWidth: 'auto',
    styles: {
      font: 'helvetica',
      fontSize,
      cellPadding: 3,
      overflow: 'linebreak',
      valign: 'middle',
      lineColor: [204, 204, 204],
      lineWidth: 0.5,
      textColor: [17, 17, 17],
      fontStyle: options.boldText ? 'bold' : 'normal',
    },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [17, 17, 17],
      fontStyle: 'bold',
      lineColor: [204, 204, 204],
      lineWidth: 0.5,
    },
    columnStyles: photoIndex >= 0
      ? { [photoIndex]: { cellWidth: PDF_PHOTO_BOX + 8, minCellHeight: PDF_PHOTO_BOX + 6 } }
      : {},
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== photoIndex) return
      const image = images.get(options.rows[data.row.index]?.[photoIndex] ?? '')
      if (!image) return
      const box = Math.min(PDF_PHOTO_BOX, data.cell.height - 4)
      const scale = Math.min(box / image.width, box / image.height)
      const width = image.width * scale
      const height = image.height * scale
      doc.addImage(
        image.dataUrl,
        'JPEG',
        data.cell.x + (data.cell.width - width) / 2,
        data.cell.y + (data.cell.height - height) / 2,
        width,
        height,
      )
    },
    didDrawPage: (data) => {
      if (options.title) {
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(14)
        doc.setTextColor(17, 17, 17)
        doc.text(options.title, PDF_MARGIN, titleBaseline)
      }

      if (!hideSummary && data.pageNumber === 1 && summaryLines.length) {
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9)
        doc.setTextColor(85, 85, 85)
        summaryLines.forEach((line, index) => doc.text(line, PDF_MARGIN, summaryTop + index * 11))
      }

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      doc.setTextColor(120, 120, 120)
      doc.text(`Page ${data.pageNumber}`, pageWidth - PDF_MARGIN, pageHeight - 12, { align: 'right' })
    },
  })

  return doc.output('blob')
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function exportRowsToExcel<T>(config: ExcelExportConfig<T>, style?: PrintStyleOptions): void | Promise<void> {
  const { rows, fields, fileName, title, meta, groupBy, showMeta } = config

  if (!fields.length) {
    toast.error('Select at least one field to export.')
    return
  }

  const headerLabels = fields.map((f) => f.label)
  const sheetRows: string[][] = []
  // Parallel to sheetRows: the source row for data rows, null for group titles,
  // headers and spacer rows. Used to place embedded photos on the right row.
  const sheetRowSources: Array<T | null> = []

  if (showMeta) {
    sheetRows.push([title])
    sheetRowSources.push(null)
    if (meta) {
      sheetRows.push([meta])
      sheetRowSources.push(null)
    }
    sheetRows.push([])
    sheetRowSources.push(null)
  }

  if (groupBy) {
    const groups = new Map<string, T[]>()
    for (const row of rows) {
      const key = groupBy.resolve(row) || ''
      const list = groups.get(key)
      if (list) {
        list.push(row)
      } else {
        groups.set(key, [row])
      }
    }

    const sorted = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))

    for (const [groupKey, groupRows] of sorted) {
      if (groupKey) {
        sheetRows.push([groupKey])
        sheetRowSources.push(null)
      }
      sheetRows.push(headerLabels)
      sheetRowSources.push(null)
      for (const row of groupRows) {
        sheetRows.push(fields.map((f) => f.getValue(row)))
        sheetRowSources.push(row)
      }
      sheetRows.push([])
      sheetRowSources.push(null)
    }
  } else {
    sheetRows.push(headerLabels)
    sheetRowSources.push(null)
    for (const row of rows) {
      sheetRows.push(fields.map((f) => f.getValue(row)))
      sheetRowSources.push(row)
    }
  }

  // When style options are provided, build the workbook with exceljs so real
  // cell borders, row heights and column widths are embedded in the file. The
  // library is only imported on demand so it never bloats the main bundle.
  if (style) {
    return (async () => {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet(title)

      for (let c = 0; c < fields.length; c++) {
        const heuristic = fields[c].key === 'name' || fields[c].key === 'photo' ? 28 : 16
        worksheet.getColumn(c + 1).width = Math.max(heuristic, style.exportColWidth)
      }

      const borderStyle = { style: 'thin', color: { argb: 'FFBFBFBF' } } as const
      const cellBorder = style.exportBorders
        ? { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle }
        : undefined

      for (let r = 0; r < sheetRows.length; r++) {
        // Yield periodically so exporting thousands of rows never freezes the tab.
        if (r > 0 && r % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        const row = worksheet.getRow(r + 1)
        if (style.exportRowHeight > 0) row.height = style.exportRowHeight
        const isHeader = sheetRows[r].length === headerLabels.length && sheetRows[r].every((value, i) => value === headerLabels[i])
        for (let c = 0; c < sheetRows[r].length; c++) {
          const cell = row.getCell(c + 1)
          cell.value = sheetRows[r][c] || null
          if (cellBorder) cell.border = cellBorder
          if (isHeader) {
            cell.font = { bold: true }
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } }
          } else if (showMeta && r === 0) {
            cell.font = { bold: true, size: 14 }
          } else if (showMeta && meta && r === 1) {
            cell.font = { italic: true, size: 10, color: { argb: 'FF666666' } }
          }
        }
      }

      const photoField = fields.find((field) => field.key === 'photo')
      if (style.includePhotos && photoField) {
        const photoCol = fields.findIndex((field) => field.key === 'photo')
        const targets: Array<{ rowIndex: number; url: string }> = []
        for (let r = 0; r < sheetRowSources.length; r++) {
          const source = sheetRowSources[r]
          if (!source) continue
          const url = photoField.getValue(source)
          if (/^(https?:|data:)/i.test(url)) targets.push({ rowIndex: r, url })
        }
        for (let i = 0; i < targets.length; i += PDF_IMAGE_CONCURRENCY) {
          const batch = targets.slice(i, i + PDF_IMAGE_CONCURRENCY)
          const images = await Promise.all(
            batch.map(async (target) => [target, await loadPdfImage(target.url)] as const),
          )
          for (const [target, image] of images) {
            if (!image) continue
            const base64 = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)
            const imageId = workbook.addImage({ base64, extension: 'jpeg' })
            const scale = Math.min(64 / image.width, 64 / image.height, 1)
            worksheet.addImage(imageId, {
              tl: { col: photoCol + 0.1, row: target.rowIndex + 0.05 },
              ext: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) },
            })
            worksheet.getRow(target.rowIndex + 1).height = Math.max(
              worksheet.getRow(target.rowIndex + 1).height ?? 0,
              52,
            )
          }
        }
      }

      const buffer = await workbook.xlsx.writeBuffer()
      await downloadExcelBuffer(buffer, `${fileName}-${new Date().toISOString().slice(0, 10)}.xlsx`)
      toast.success('Excel file exported.')
    })()
  }
  const worksheet = XLSX.utils.aoa_to_sheet(sheetRows)
  worksheet['!cols'] = fields.map((f) => ({ wch: f.key === 'name' || f.key === 'photo' ? 28 : 16 }))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, title)
  XLSX.writeFile(workbook, `${fileName}-${new Date().toISOString().slice(0, 10)}.xlsx`)

  toast.success('Excel file exported.')
}

export interface ExcelWorkbookSheet {
  name: string
  rows: Array<Array<string | number>>
  colWidths?: Array<{ wch?: number }>
}

// Shared multi-sheet Excel export used by analysis-style pages (Insights,
// Dashboard). When style options are provided it writes real borders, row
// heights and column widths through exceljs; otherwise it falls back to the
// plain SheetJS path so existing callers keep their current output.
export async function exportWorkbookToExcel(
  sheets: ExcelWorkbookSheet[],
  fileName: string,
  style?: PrintStyleOptions,
): Promise<void> {
  if (style) {
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    const borderStyle = { style: 'thin', color: { argb: 'FFBFBFBF' } } as const
    const cellBorder = style.exportBorders
      ? { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle }
      : undefined

    for (const sheetDef of sheets) {
      const sheet = workbook.addWorksheet(sheetDef.name)
      for (let c = 0; c < (sheetDef.colWidths?.length ?? sheetDef.rows[0]?.length ?? 0); c++) {
        const wch = sheetDef.colWidths?.[c]?.wch ?? 10
        sheet.getColumn(c + 1).width = Math.max(wch, style.exportColWidth)
      }
      for (let r = 0; r < sheetDef.rows.length; r++) {
        if (r > 0 && r % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        const row = sheet.getRow(r + 1)
        if (style.exportRowHeight > 0) row.height = style.exportRowHeight
        const isHeader = r === 0
        for (let c = 0; c < sheetDef.rows[r].length; c++) {
          const cell = row.getCell(c + 1)
          cell.value = sheetDef.rows[r][c] ?? null
          if (cellBorder) cell.border = cellBorder
          if (isHeader) {
            cell.font = { bold: true }
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } }
          }
        }
      }
    }

    const buffer = await workbook.xlsx.writeBuffer()
    await downloadExcelBuffer(buffer, fileName)
    toast.success('Excel file exported.')
    return
  }

  const workbook = XLSX.utils.book_new()
  for (const sheetDef of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheetDef.rows)
    if (sheetDef.colWidths) worksheet['!cols'] = sheetDef.colWidths
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetDef.name)
  }
  XLSX.writeFile(workbook, fileName)
  toast.success('Excel file exported.')
}

async function downloadExcelBuffer(buffer: ArrayBuffer | Uint8Array, fileName: string): Promise<void> {
  const bytes = buffer instanceof Uint8Array ? new Uint8Array(buffer) : buffer
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function buildPrintHtml<T>(config: PrintConfig<T>, style?: PrintStyleOptions): string {
  const { rows, fields, title, meta, groupBy, photoResolver, footer } = config
  const fontSize = style?.fontSize ?? 11
  const bold = style?.boldText ?? false
  // Photos scale proportionally with the font size so printed rows stay balanced.
  const photoSize = Math.max(10, Math.round(30 * (fontSize / 11)))

  const headerLabels = fields.map((f) => f.label)

  let bodyHtml = ''

  const renderRow = (row: T) => {
    const cells = fields
      .map((f) => {
        const value = f.getValue(row)
        if (f.key === 'photo' && photoResolver) {
          const url = photoResolver(row)
          return `<td>${url ? `<img class="photo" src="${escapeHtml(url)}" decoding="async" />` : ''}</td>`
        }
        if (f.key === 'photo') {
          return `<td>${value ? `<img class="photo" src="${escapeHtml(value)}" decoding="async" />` : ''}</td>`
        }
        return `<td>${escapeHtml(value)}</td>`
      })
      .join('')
    return `<tr>${cells}</tr>`
  }

  if (groupBy) {
    const groups = new Map<string, T[]>()
    for (const row of rows) {
      const key = groupBy.resolve(row) || ''
      const list = groups.get(key)
      if (list) {
        list.push(row)
      } else {
        groups.set(key, [row])
      }
    }

    const sorted = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))

    for (const [groupKey, groupRows] of sorted) {
      let groupHtml = ''
      if (groupKey) {
        groupHtml += `<h2 class="group-title">${escapeHtml(groupKey)}</h2>`
      }
      groupHtml += `<table><thead><tr>${headerLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>`
      for (const row of groupRows) {
        groupHtml += renderRow(row)
      }
      groupHtml += '</tbody></table>'
      bodyHtml += style?.keepGroupTogether ? `<div class="report-group">${groupHtml}</div>` : groupHtml
    }
  } else {
    bodyHtml += `<table><thead><tr>${headerLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>`
    for (const row of rows) {
      bodyHtml += renderRow(row)
    }
    bodyHtml += '</tbody></table>'
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: 0.04em; }
  .meta { font-size: 12px; color: #555; margin-bottom: 20px; }
  .group-title { font-size: 15px; margin: 24px 0 8px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  .report-group { break-inside: avoid; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: ${fontSize}px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { background: #f0f0f0; }
  ${bold ? 'th, td { font-weight: 700; }' : ''}
  .photo { width: ${photoSize}px; height: ${photoSize}px; object-fit: cover; border-radius: 50%; }
  .print-footer { margin-top: 16px; padding-top: 10px; border-top: 2px solid #333; font-size: 13px; font-weight: 700; }
  @media print {
    tr { break-inside: avoid; }
    .group-title { break-after: avoid; }
    .print-footer { break-inside: avoid; }
  }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
  ${bodyHtml}
  ${footer ? `<div class="print-footer">${escapeHtml(footer)}</div>` : ''}
</body>
</html>`
}

// Stream the body of a large HTML report into the print window in bounded
// chunks instead of writing the whole document at once. This keeps the main
// thread responsive so large reports (thousands of voters) no longer freeze
// the tab or the browser.
const PRINT_WRITE_CHUNK_SIZE = 40000

export function openPrintWindow(html: string): void {
  const printWindow = window.open('', '_blank')
  if (!printWindow) {
    toast.error('Popup blocked. Please allow popups for this site to print.')
    return
  }

  const doc = printWindow.document
  const headEnd = html.indexOf('</head>')
  const bodyEnd = html.indexOf('</body>')

  doc.open()

  // A single `document.write` of a multi-megabyte string (thousands of rows
  // plus hundreds of photos) blocks the main thread for seconds and can freeze
  // the whole tab. Instead, write the static <head> immediately, then stream
  // the body in bounded chunks, yielding to the event loop between writes so
  // the browser (and the source page) stays responsive while the report is
  // being assembled in the print window.
  if (headEnd === -1 || bodyEnd === -1 || bodyEnd < headEnd) {
    doc.write(html)
    doc.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 150)
    return
  }

  doc.write(html.slice(0, headEnd + '</head>'.length))

  const body = html.slice(headEnd + '</head>'.length, bodyEnd)
  const tail = html.slice(bodyEnd)
  let offset = 0

  const streamBody = () => {
    if (offset < body.length) {
      const end = Math.min(offset + PRINT_WRITE_CHUNK_SIZE, body.length)
      doc.write(body.slice(offset, end))
      offset = end
      setTimeout(streamBody, 0)
      return
    }
    doc.write(tail)
    doc.close()
    printWindow.focus()
    waitForImagesThenPrint(doc, printWindow)
  }

  streamBody()
}

// After the document is fully assembled, wait for photos to finish loading
// (with a cap) before opening the print dialog, otherwise large reports print
// with empty photo cells or trigger layout churn while images stream in.
function waitForImagesThenPrint(doc: Document, win: Window, maxWaitMs = 5000): void {
  const started = Date.now()
  const check = () => {
    const pending = Array.from(doc.images).filter((img) => !img.complete)
    if (pending.length === 0 || Date.now() - started >= maxWaitMs) {
      win.focus()
      win.print()
      return
    }
    setTimeout(check, 120)
  }
  setTimeout(check, 200)
}

export function handlePrint<T>(config: PrintConfig<T>, style?: PrintStyleOptions): void {
  if (!config.fields.length) {
    toast.error('Select at least one field to print.')
    return
  }

  const html = buildPrintHtml(config, style)
  openPrintWindow(html)
}
