/**
 * Minimal PostgREST-compatible query parser.
 *
 * Scope note: this deliberately supports only the subset of PostgREST that this app
 * actually uses. Anything it does not fully understand throws, so an unsupported
 * query fails loudly with a 400 instead of silently returning wrong (or unfiltered)
 * rows — which for a filter expression would be a security bug, not just a display bug.
 */

export class RestQueryError extends Error {}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new RestQueryError(`Invalid identifier: ${name}`)
  }
  return name
}

/** Column lists are validated as identifiers, so they can be inlined safely. */
export function parseSelect(select: string | null): string {
  if (!select || select.trim() === '*') return '*'
  if (select.includes('(')) {
    throw new RestQueryError('Embedded resource selects are not supported')
  }
  return select
    .split(',')
    .map((raw) => {
      const part = raw.trim()
      if (!part) throw new RestQueryError('Empty column in select')
      // Support "alias:column" form.
      const [first, second] = part.split(':')
      return second
        ? `${assertIdentifier(second.trim())} AS ${assertIdentifier(first.trim())}`
        : assertIdentifier(part)
    })
    .join(', ')
}

export interface Condition {
  sql: string
  params: unknown[]
}

function decodeValue(raw: string): unknown {
  if (raw === 'null') return null
  if (raw === 'true') return 1
  if (raw === 'false') return 0
  // PostgREST quotes values containing reserved characters.
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  return raw
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  let inQuotes = false

  for (const char of input) {
    if (char === '"') inQuotes = !inQuotes
    if (!inQuotes) {
      if (char === '(') depth++
      else if (char === ')') depth--
      else if (char === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += char
  }
  if (current) parts.push(current)
  return parts
}

/** Parses a single `column=operator.value` filter into SQL. */
function parseFilter(column: string, expression: string): Condition {
  let negated = false
  let rest = expression

  if (rest.startsWith('not.')) {
    negated = true
    rest = rest.slice(4)
  }

  const dot = rest.indexOf('.')
  if (dot === -1) throw new RestQueryError(`Malformed filter: ${column}=${expression}`)

  const operator = rest.slice(0, dot)
  const rawValue = rest.slice(dot + 1)
  const col = assertIdentifier(column)

  const wrap = (sql: string): string => (negated ? `NOT (${sql})` : sql)

  switch (operator) {
    case 'eq':
      if (decodeValue(rawValue) === null) return { sql: wrap(`${col} IS NULL`), params: [] }
      return { sql: wrap(`${col} = ?`), params: [decodeValue(rawValue)] }
    case 'neq':
      return { sql: wrap(`${col} <> ?`), params: [decodeValue(rawValue)] }
    case 'gt':
      return { sql: wrap(`${col} > ?`), params: [decodeValue(rawValue)] }
    case 'gte':
      return { sql: wrap(`${col} >= ?`), params: [decodeValue(rawValue)] }
    case 'lt':
      return { sql: wrap(`${col} < ?`), params: [decodeValue(rawValue)] }
    case 'lte':
      return { sql: wrap(`${col} <= ?`), params: [decodeValue(rawValue)] }
    case 'is': {
      const value = decodeValue(rawValue)
      if (value === null) return { sql: wrap(`${col} IS NULL`), params: [] }
      return { sql: wrap(`${col} = ?`), params: [value] }
    }
    case 'like':
      return { sql: wrap(`${col} LIKE ?`), params: [rawValue] }
    case 'ilike':
      // SQLite LIKE is case-insensitive for ASCII by default.
      return { sql: wrap(`${col} LIKE ?`), params: [rawValue] }
    case 'in': {
      const inner = rawValue.replace(/^\(/, '').replace(/\)$/, '')
      const values = inner ? splitTopLevel(inner).map((v) => decodeValue(v.trim())) : []
      if (values.length === 0) return { sql: wrap('0=1'), params: [] }
      if (values.length > 80) {
        throw new RestQueryError(`IN list too large (${values.length}). Maximum is 80.`)
      }
      return {
        sql: wrap(`${col} IN (${values.map(() => '?').join(',')})`),
        params: values,
      }
    }
    default:
      throw new RestQueryError(`Unsupported operator: ${operator}`)
  }
}

/** Parses PostgREST's `or=(a.eq.1,b.eq.2)` grouping. */
function parseOr(value: string): Condition {
  const inner = value.replace(/^\(/, '').replace(/\)$/, '')
  const parts = splitTopLevel(inner)
  const conditions: Condition[] = []

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const dot = trimmed.indexOf('.')
    if (dot === -1) throw new RestQueryError(`Malformed or() member: ${trimmed}`)
    conditions.push(parseFilter(trimmed.slice(0, dot), trimmed.slice(dot + 1)))
  }

  if (conditions.length === 0) throw new RestQueryError('Empty or() filter')

  return {
    sql: `(${conditions.map((c) => c.sql).join(' OR ')})`,
    params: conditions.flatMap((c) => c.params),
  }
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

export function parseFilters(params: URLSearchParams): Condition {
  const conditions: Condition[] = []

  for (const [key, value] of params.entries()) {
    if (RESERVED.has(key)) continue
    conditions.push(key === 'or' ? parseOr(value) : parseFilter(key, value))
  }

  if (conditions.length === 0) return { sql: '', params: [] }

  return {
    sql: conditions.map((c) => c.sql).join(' AND '),
    params: conditions.flatMap((c) => c.params),
  }
}

export function parseOrder(order: string | null): string {
  if (!order) return ''
  const clauses = order.split(',').map((raw) => {
    const [column, ...modifiers] = raw.trim().split('.')
    const col = assertIdentifier(column)
    const direction = modifiers.includes('desc') ? 'DESC' : 'ASC'
    if (modifiers.includes('nullsfirst')) return `${col} IS NULL DESC, ${col} ${direction}`
    if (modifiers.includes('nullslast')) return `${col} IS NULL, ${col} ${direction}`
    return `${col} ${direction}`
  })
  return clauses.join(', ')
}

/** Reads the row window from either a Range header or limit/offset params. */
export function parseRange(
  rangeHeader: string | null,
  params: URLSearchParams,
  maxLimit: number
): { limit: number; offset: number } {
  const limitParam = params.get('limit')
  const offsetParam = params.get('offset')

  if (limitParam) {
    return {
      limit: Math.min(Number(limitParam) || maxLimit, maxLimit),
      offset: Math.max(Number(offsetParam) || 0, 0),
    }
  }

  if (rangeHeader) {
    const [startRaw, endRaw] = rangeHeader.split('-')
    const start = Math.max(Number(startRaw) || 0, 0)
    const end = Number(endRaw)
    if (Number.isFinite(end) && end >= start) {
      return { limit: Math.min(end - start + 1, maxLimit), offset: start }
    }
    return { limit: maxLimit, offset: start }
  }

  return { limit: maxLimit, offset: 0 }
}

export { assertIdentifier }
