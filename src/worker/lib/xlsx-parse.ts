/**
 * XLSX voter-sheet parsing, ported from the former Supabase Edge Function
 * (supabase/functions/import-voters). Kept free of Worker/D1 specifics so it can be
 * unit-reasoned about and reused by the chunked import routes.
 */

export interface ParsedRow {
  rowNumber: number
  epic_no: string
  name: string
  relative_name: string | null
  relative_relation: string | null
  section_name: string | null
  part_no: number | null
  section: number | null
  sr_no_roll: number | null
  house_no: string | null
  age: number | null
  date_of_birth: string | null
  contact_no_1: string | null
  contact_no_2: string | null
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null
  religion: string | null
  state: string | null
  family_head_epic: string | null
}

export const HEADER_ALIASES: Record<string, string[]> = {
  section_name: ['SECTION NAME', 'SECTION_NAME'],
  part_no: ['PART NO', 'PART NO.', 'PART_NO', 'PARTNO'],
  section: ['SECTION', 'SECTION NO', 'SECTION NO.', 'SECTION_NO', 'SECTION NUMBER'],
  sr_no_roll: [
    'SR AS PER ROLL',
    'SR AS PER 26 ROLL',
    'SR NO',
    'SR_NO_ROLL',
    'SL NO',
    'VOTERSERIAL',
    'VOTER SERIAL',
    'VOTER SR NO',
    'SERIAL NO',
  ],
  name: ['NAME', 'VOTER NAME', 'FULL NAME', 'ELECTOR NAME', 'NAME OF ELECTOR', 'NAME OF THE ELECTOR', 'NAME OF VOTER', 'ELECTOR'],
  relative_name: ['RELATIVE NAME', 'RELATIVE', 'FATHER NAME', 'HUSBAND NAME', 'RELATION NAME'],
  relative_relation: ['RELATIVE RELATION', 'RELATION', 'RELATION TYPE'],
  epic_no: ['EPIC NO', 'EPIC ID', 'VOTER ID', 'EPIC_NO', 'EPICNO', 'EPIC', 'EPIC NUMBER', 'ID CARD', 'ELECTORAL PHOTO IDENTITY CARD'],
  house_no: ['HOUSE NO.', 'HOUSE NO', 'HOUSE_NO'],
  age: ['AGE', 'AGE YEARS'],
  date_of_birth: ['DATE OF BIRTH', 'DOB', 'BIRTH DATE'],
  contact_no_1: ['CONTACT NO 1', 'CONTACT 1', 'MOBILE', 'MOBILE NO', 'PHONE', 'PHONE NUMBER'],
  contact_no_2: ['CONTACT NO 2 (OLD DATA)', 'CONTACT NO 2', 'CONTACT 2'],
  gender: ['GENDER'],
  religion: ['RELIGION'],
  state: ['STATE'],
  family_head_epic: ['FAMILY STATUS', 'FAMILY_HEAD_EPIC'],
}

export const REQUIRED_FIELDS = ['epic_no', 'name'] as const

export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (Array.isArray(value)) return value.map((part) => cellToText(part)).join('')
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>
    if (typeof cell.w === 'string' && cell.w.trim()) return cell.w
    if (Array.isArray(cell.r)) return cell.r.map((part) => cellToText(part)).join('')
    if (typeof cell.t === 'string' && cell.t.trim() && cell.t !== 's' && cell.t !== 'n' && cell.t !== 'b' && cell.t !== 'd' && cell.t !== 'e') {
      return cell.t
    }
    if (cell.v !== undefined && cell.v !== value) return cellToText(cell.v)
    if (typeof cell.text === 'string') return cell.text
  }
  const text = String(value)
  return text === '[object Object]' ? '' : text
}

export function normalizeHeader(value: unknown): string {
  return cellToText(value)
    .replace(/^\uFEFF/, '')
    .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
}

export function compactHeader(value: unknown): string {
  return normalizeHeader(value).replace(/[^A-Z0-9]/g, '')
}

const EPIC_VALUE = /^[A-Z]{3}[0-9]{5,}$/

export function isEpicLike(value: unknown): boolean {
  const compact = cellToText(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return EPIC_VALUE.test(compact)
}

export function isPersonNameLike(value: unknown): boolean {
  const text = cellToText(value).trim()
  if (text.length < 3 || text.length > 80) return false
  if (isEpicLike(text)) return false
  const upper = text.toUpperCase()
  if (['MALE', 'FEMALE', 'OTHER', 'M', 'F', 'O'].includes(upper)) return false
  if (/^\d+$/.test(text)) return false
  return /[A-Za-z\u00C0-\u024F]/.test(text)
}

export function parseInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseInt(String(value), 10)
  return Number.isNaN(parsed) ? null : parsed
}

export function parseDate(value: unknown): string | null {
  if (!value) return null

  // Excel serial dates are days since 1899-12-30.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30)
    const parsed = new Date(excelEpoch + Math.trunc(value) * 86400000)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }

  const text = String(value).trim()
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
  if (dmy) {
    const parsed = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])))
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  }

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

export function deriveAgeFromDob(value: string | null): number | null {
  if (!value) return null
  const dob = new Date(value)
  if (Number.isNaN(dob.getTime())) return null

  const today = new Date()
  let age = today.getUTCFullYear() - dob.getUTCFullYear()
  const monthDiff = today.getUTCMonth() - dob.getUTCMonth()
  const dayDiff = today.getUTCDate() - dob.getUTCDate()
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1

  return age < 0 || age > 130 ? null : age
}

export function cleanPhone(value: unknown): string | null {
  if (!value) return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    const digits = Math.trunc(value).toString().replace(/\D/g, '')
    if (digits.length >= 10) return digits.slice(-10)
  }

  const digits = String(value).replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}

export function toGender(value: unknown): 'MALE' | 'FEMALE' | 'OTHER' | null {
  if (!value) return null
  const normalized = String(value).trim().toUpperCase()
  if (normalized === 'M' || normalized === 'MALE' || normalized === 'MALE.') return 'MALE'
  if (normalized === 'F' || normalized === 'FEMALE' || normalized === 'FEMALE.') return 'FEMALE'
  if (normalized === 'O' || normalized === 'OTHER' || normalized === 'OTHER.') return 'OTHER'
  return null
}

export function getHeaderMapping(
  headers: unknown[],
  manualMapping?: Record<string, string>
): Record<string, string> {
  const normalizedHeaders = headers.map((value) => normalizeHeader(value))
  const compactHeaders = normalizedHeaders.map((value) => compactHeader(value))
  const mapping: Record<string, string> = {}

  for (const [target, aliases] of Object.entries(HEADER_ALIASES)) {
    if (manualMapping?.[target]) {
      mapping[target] = manualMapping[target]
      continue
    }

    const aliasList = [...aliases, target]
    const exact = aliasList
      .map((alias) => normalizeHeader(alias))
      .find((alias) => alias && normalizedHeaders.includes(alias))

    if (exact) {
      mapping[target] = exact
      continue
    }

    const compactMatch = aliasList
      .map((alias) => compactHeader(alias))
      .find((alias) => alias && compactHeaders.includes(alias))

    if (compactMatch) {
      const index = compactHeaders.indexOf(compactMatch)
      mapping[target] = normalizedHeaders[index]
    }
  }

  if (!mapping.epic_no) {
    const epicIndex = compactHeaders.findIndex((header) => header.includes('EPIC') && !header.includes('FAMILY'))
    if (epicIndex >= 0) mapping.epic_no = normalizedHeaders[epicIndex]
  }

  if (!mapping.name) {
    const nameIndex = normalizedHeaders.findIndex((header) => {
      if (!header) return false
      if (header === 'NAME' || header.startsWith('NAME OF')) return true
      if (header === 'VOTER NAME' || header === 'FULL NAME' || header === 'ELECTOR NAME') return true
      return false
    })
    if (nameIndex >= 0) mapping.name = normalizedHeaders[nameIndex]
  }

  return mapping
}

const HEADER_SCAN_ROWS = 80

export function combineHeaderRows(rowA: unknown[] = [], rowB: unknown[] = []): string[] {
  const len = Math.max(rowA.length, rowB.length)
  const combined: string[] = []
  for (let i = 0; i < len; i += 1) {
    const top = cellToText(rowA[i]).trim()
    const bottom = cellToText(rowB[i]).trim()
    combined.push([top, bottom].filter(Boolean).join(' '))
  }
  return combined
}

export function findHeaderRowIndex(
  matrix: unknown[][],
  manualMapping?: Record<string, string>
): number {
  const scanLimit = Math.min(matrix.length, HEADER_SCAN_ROWS)
  let bestIndex = 0
  let bestScore = -1
  for (let i = 0; i < scanLimit; i += 1) {
    const headers = matrix[i] ?? []
    if (headers.every((value) => cellToText(value).trim() === '')) continue
    const mapping = getHeaderMapping(headers, manualMapping)
    const score = Object.keys(mapping).length
    if (REQUIRED_FIELDS.every((field) => mapping[field])) return i

    const combined = combineHeaderRows(headers, matrix[i + 1] ?? [])
    const combinedMapping = getHeaderMapping(combined, manualMapping)
    const combinedScore = Object.keys(combinedMapping).length
    if (REQUIRED_FIELDS.every((field) => combinedMapping[field])) return i
    const usedScore = Math.max(score, combinedScore)
    if (usedScore > bestScore) {
      bestScore = usedScore
      bestIndex = i
    }
  }
  return bestIndex
}

export function inferRequiredColumns(
  matrix: unknown[][],
  headerRowIndex: number,
  mapping: Record<string, string>
): Record<string, string> {
  const next = { ...mapping }
  const sampleRows = matrix.slice(headerRowIndex + 1, headerRowIndex + 21)
  if (!sampleRows.length) return next

  const colCount = Math.max(
    ...(matrix[headerRowIndex] ?? []).map((_, i) => i + 1),
    ...sampleRows.map((row) => row.length),
    0
  )

  if (!next.epic_no) {
    let bestCol = -1
    let bestHits = 0
    for (let col = 0; col < colCount; col += 1) {
      const hits = sampleRows.filter((row) => isEpicLike(row[col])).length
      if (hits > bestHits) {
        bestHits = hits
        bestCol = col
      }
    }
    if (bestCol >= 0 && bestHits >= Math.max(1, Math.ceil(sampleRows.length * 0.4))) {
      next.epic_no = `__COL_${bestCol}`
    }
  }

  if (!next.name) {
    let bestCol = -1
    let bestHits = 0
    const epicCol = next.epic_no?.startsWith('__COL_') ? Number(next.epic_no.slice(6)) : -1
    for (let col = 0; col < colCount; col += 1) {
      if (col === epicCol) continue
      const hits = sampleRows.filter((row) => isPersonNameLike(row[col])).length
      if (hits > bestHits) {
        bestHits = hits
        bestCol = col
      }
    }
    if (bestCol >= 0 && bestHits >= Math.max(1, Math.ceil(sampleRows.length * 0.4))) {
      next.name = `__COL_${bestCol}`
    }
  }

  return next
}

/** Later rows win per-field, but never blank out a value the earlier row had. */
export function mergeParsedRows(existing: ParsedRow, incoming: ParsedRow): ParsedRow {
  return {
    ...existing,
    name: incoming.name || existing.name,
    relative_name: incoming.relative_name ?? existing.relative_name,
    relative_relation: incoming.relative_relation ?? existing.relative_relation,
    section_name: incoming.section_name ?? existing.section_name,
    part_no: incoming.part_no ?? existing.part_no,
    section: incoming.section ?? existing.section,
    sr_no_roll: incoming.sr_no_roll ?? existing.sr_no_roll,
    house_no: incoming.house_no ?? existing.house_no,
    age: incoming.age ?? existing.age,
    date_of_birth: incoming.date_of_birth ?? existing.date_of_birth,
    contact_no_1: incoming.contact_no_1 ?? existing.contact_no_1,
    contact_no_2: incoming.contact_no_2 ?? existing.contact_no_2,
    gender: incoming.gender ?? existing.gender,
    religion: incoming.religion ?? existing.religion,
    state: incoming.state ?? existing.state,
    family_head_epic: incoming.family_head_epic ?? existing.family_head_epic,
    rowNumber: Math.min(existing.rowNumber, incoming.rowNumber),
  }
}

export interface ParseResult {
  rows: ParsedRow[]
  errors: Array<{ row: number; reason: string }>
  warnings: Array<{ row: number; reason: string }>
  totalDataRows: number
}

/**
 * Turns the raw sheet matrix into deduped voter rows.
 * `part_no` / `section` / `section_name` carry forward down the sheet, because these
 * roll exports only repeat them on the first row of each block.
 */
export function parseSheetRows(
  matrix: unknown[][],
  manualMapping?: Record<string, string>
): ParseResult {
  if (matrix.length === 0) {
    return { rows: [], errors: [{ row: 0, reason: 'Sheet is empty.' }], warnings: [], totalDataRows: 0 }
  }

  const headerRowIndex = findHeaderRowIndex(matrix, manualMapping)
  const singleHeaderRow = (matrix[headerRowIndex] ?? []).map((value) => normalizeHeader(value))
  const combinedHeaderRow = combineHeaderRows(matrix[headerRowIndex] ?? [], matrix[headerRowIndex + 1] ?? []).map((value) => normalizeHeader(value))
  const singleMapping = getHeaderMapping(singleHeaderRow, manualMapping)
  const combinedMapping = getHeaderMapping(combinedHeaderRow, manualMapping)
  const useCombined =
    REQUIRED_FIELDS.some((field) => !singleMapping[field]) &&
    REQUIRED_FIELDS.every((field) => combinedMapping[field])
  const headerRow = useCombined ? combinedHeaderRow : singleHeaderRow
  const dataStartIndex = useCombined ? headerRowIndex + 2 : headerRowIndex + 1
  let mapping = useCombined ? combinedMapping : singleMapping
  mapping = inferRequiredColumns(matrix, useCombined ? headerRowIndex + 1 : headerRowIndex, mapping)

  const missing = REQUIRED_FIELDS.filter((field) => !mapping[field])
  if (missing.length > 0) {
    const found = headerRow.filter((value) => value).join(', ') || '(empty header row)'
    return {
      rows: [],
      errors: [{
        row: headerRowIndex + 1,
        reason: `Missing required column(s): ${missing.join(', ')}. Found headers: ${found}`,
      }],
      warnings: [],
      totalDataRows: 0,
    }
  }

  const headerIndex: Record<string, number> = {}
  headerRow.forEach((header, index) => {
    if (header && !(header in headerIndex)) headerIndex[header] = index
  })

  const errors: Array<{ row: number; reason: string }> = []
  const warnings: Array<{ row: number; reason: string }> = []
  const deduped = new Map<string, ParsedRow>()

  let lastPartNo: number | null = null
  let lastSection: number | null = null
  let lastSectionName: string | null = null
  let totalDataRows = 0

  for (let i = dataStartIndex; i < matrix.length; i += 1) {
    const source = matrix[i] ?? []
    const excelRowNumber = i + 1

    if (source.every((cell) => cellToText(cell).trim() === '')) continue
    totalDataRows += 1

    const pick = (field: string): unknown => {
      const header = mapping[field]
      if (!header) return ''
      if (header.startsWith('__COL_')) {
        const index = Number(header.slice(6))
        return Number.isNaN(index) ? '' : source[index]
      }
      const index = headerIndex[header]
      return index === undefined ? '' : source[index]
    }

    const epicNo = cellToText(pick('epic_no')).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || cellToText(pick('epic_no')).trim().toUpperCase()
    const name = cellToText(pick('name')).trim()

    if (!epicNo) {
      errors.push({ row: excelRowNumber, reason: 'EPIC is required.' })
      continue
    }
    if (!name) {
      errors.push({ row: excelRowNumber, reason: 'Name is required.' })
      continue
    }

    const partNo: number | null = parseInteger(pick('part_no')) ?? lastPartNo
    const section: number | null = parseInteger(pick('section')) ?? lastSection
    const rawSectionName = cellToText(pick('section_name')).trim()
    const sectionName: string | null = rawSectionName || lastSectionName

    lastPartNo = partNo
    lastSection = section
    lastSectionName = sectionName

    const dob = parseDate(pick('date_of_birth'))
    const explicitAge = parseInteger(pick('age'))
    const age = explicitAge ?? deriveAgeFromDob(dob)

    const row: ParsedRow = {
      rowNumber: excelRowNumber,
      epic_no: epicNo,
      name,
      relative_name: cellToText(pick('relative_name')).trim() || null,
      relative_relation: cellToText(pick('relative_relation')).trim() || null,
      section_name: sectionName,
      part_no: partNo,
      section,
      sr_no_roll: parseInteger(pick('sr_no_roll')),
      house_no: cellToText(pick('house_no')).trim() || null,
      age,
      date_of_birth: dob,
      contact_no_1: cleanPhone(pick('contact_no_1')),
      contact_no_2: cleanPhone(pick('contact_no_2')),
      gender: toGender(pick('gender')),
      religion: cellToText(pick('religion')).trim() || null,
      state: cellToText(pick('state')).trim() || null,
      family_head_epic: cellToText(pick('family_head_epic')).trim().toUpperCase() || null,
    }

    const existing = deduped.get(row.epic_no)
    if (!existing) {
      deduped.set(row.epic_no, row)
      continue
    }

    warnings.push({
      row: excelRowNumber,
      reason: `Duplicate EPIC ${row.epic_no} in same file; merged into a single voter record.`,
    })
    deduped.set(row.epic_no, mergeParsedRows(existing, row))
  }

  return { rows: [...deduped.values()], errors, warnings, totalDataRows }
}
