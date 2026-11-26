import * as XLSX from 'xlsx'
import { cellToText, parseSheetRows, type ParseResult } from './xlsx-parse'

function decodeSheetCell(cell: XLSX.CellObject | undefined): unknown {
  if (!cell) return ''
  const fromObject = cellToText(cell)
  if (fromObject.trim()) return fromObject
  if (typeof cell.w === 'string' && cell.w.trim()) return cell.w
  if (cell.v !== undefined && cell.v !== null) return cell.v
  return ''
}

export function sheetToMatrix(sheet: XLSX.WorkSheet): unknown[][] {
  const ref = sheet['!ref']
  if (!ref) {
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as unknown[][]
  }

  const range = XLSX.utils.decode_range(ref)
  const matrix: unknown[][] = []
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row: unknown[] = []
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c })
      row.push(decodeSheetCell(sheet[addr] as XLSX.CellObject | undefined))
    }
    matrix.push(row)
  }

  for (const merge of sheet['!merges'] ?? []) {
    const value = matrix[merge.s.r]?.[merge.s.c]
    if (value === undefined || value === '') continue
    for (let r = merge.s.r; r <= merge.e.r; r += 1) {
      for (let c = merge.s.c; c <= merge.e.c; c += 1) {
        if (!matrix[r]) matrix[r] = []
        if (cellToText(matrix[r][c]).trim() === '') matrix[r][c] = value
      }
    }
  }

  return matrix
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

function extractXlsxBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (looksLikeZip(bytes)) return bytes

  let start = -1
  for (let i = 0; i < bytes.length - 3; i += 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      start = i
      break
    }
  }
  if (start < 0) return bytes

  let end = bytes.length
  for (let i = start + 4; i < bytes.length - 3; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x2d && bytes[i + 3] === 0x2d) {
      end = i
      break
    }
  }
  return bytes.subarray(start, end)
}

export function parseWorkbook(bytes: ArrayBuffer | Uint8Array, manualMapping?: Record<string, string>): ParseResult & { sheetName: string } {
  const workbook = XLSX.read(extractXlsxBytes(bytes), { type: 'array', cellDates: true, cellNF: true, raw: false })
  if (!workbook.SheetNames.length) {
    return { rows: [], errors: [{ row: 0, reason: 'Workbook has no sheets' }], warnings: [], totalDataRows: 0, sheetName: '' }
  }

  let best: ParseResult & { sheetName: string } = {
    rows: [],
    errors: [{ row: 0, reason: 'No valid rows found' }],
    warnings: [],
    totalDataRows: 0,
    sheetName: workbook.SheetNames[0],
  }

  for (const sheetName of workbook.SheetNames) {
    const matrix = sheetToMatrix(workbook.Sheets[sheetName])
    if (!matrix.length) continue
    const parsed = parseSheetRows(matrix, manualMapping)
    if (parsed.rows.length > 0) return { ...parsed, sheetName }
    const foundScore = parsed.errors[0]?.reason.includes('Found headers:') ? 1 : 0
    const bestScore = best.errors[0]?.reason.includes('Found headers:') ? 1 : 0
    if (foundScore >= bestScore) best = { ...parsed, sheetName }
  }

  return best
}
