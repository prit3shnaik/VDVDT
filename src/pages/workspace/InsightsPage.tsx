import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Loader2, Printer, RefreshCcw } from 'lucide-react'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { Button } from '../../components/ui/Button'
import { supabase } from '../../lib/supabase'
import { usePersistentState } from '../../hooks/usePersistentState'
import { useAuth } from '../../hooks/useAuth'
import { FAST_NAV_CACHE_MAX_AGE_MS, buildWardScope, readCachedCollection, writeCachedCollection } from '../../lib/voterCache'
import { normalizeLookupValue } from '../../lib/searchUtils'
import { VOTER_CATEGORY_OPTIONS, migrateRetiredCategoryFilter, voterCategoryLabel, withNormalizedVoterCategories } from '../../lib/voterCategory'
import { ReportConfigModal } from '../../components/common/ReportConfigModal'
import { buildPrintHtml, downloadPdfTable, openPrintWindow, type PrintStyleOptions, type ReportFieldDef } from '../../lib/reportBuilder'

const INSIGHTS_CACHE_KEY = 'vote:insights:rows-cache-v3'
const MAX_LEVELS = 4

type LevelKey = 'part' | 'section' | 'sectionName' | 'ward' | 'gender' | 'religion' | 'state'

const LEVEL_OPTIONS: Array<{ value: LevelKey; label: string }> = [
  { value: 'part', label: 'Part' },
  { value: 'section', label: 'Section' },
  { value: 'sectionName', label: 'Section Name' },
  { value: 'ward', label: 'Ward' },
  { value: 'gender', label: 'Gender' },
  { value: 'religion', label: 'Religion' },
  { value: 'state', label: 'State' },
]

const LEVEL_LABELS: Record<LevelKey, string> = Object.fromEntries(LEVEL_OPTIONS.map((option) => [option.value, option.label])) as Record<LevelKey, string>

type MatrixDimension = 'religion' | 'state' | 'part' | 'section' | 'category' | 'ageBand'

const MATRIX_DIMENSION_OPTIONS: Array<{ value: MatrixDimension; label: string }> = [
  { value: 'religion', label: 'Religion' },
  { value: 'state', label: 'State' },
  { value: 'part', label: 'Part' },
  { value: 'section', label: 'Section' },
  { value: 'category', label: 'Category' },
  { value: 'ageBand', label: 'Age Band' },
]

const MATRIX_DIMENSION_LABELS = Object.fromEntries(MATRIX_DIMENSION_OPTIONS.map((option) => [option.value, option.label])) as Record<MatrixDimension, string>

const AGE_BAND_OPTIONS = ['18-25', '26-35', '36-45', '46-60', '60+', 'Unknown/Under 18']

type ReligionBucket = 'hindu' | 'muslim' | 'catholic' | 'other'

interface ReligionPartRow {
  key: string
  part: string
  section: string
  hindu: number
  muslim: number
  catholic: number
  other: number
  total: number
}

function classifyReligion(value: string | null | undefined): ReligionBucket {
  const key = (value ?? '').trim().toUpperCase()
  if (key === 'HINDU') return 'hindu'
  if (key === 'MUSLIM') return 'muslim'
  if (key === 'CATHOLIC') return 'catholic'
  return 'other'
}

interface MatrixAcc {
  male: number
  female: number
  other: number
  contact: number
}

interface MatrixRow {
  id: string
  label: string
  dimension: MatrixDimension
  male: number
  female: number
  other: number
  total: number
  femalePct: number
  contactPct: number
  children: MatrixRow[]
}

interface VoterRow {
  id: string
  name: string | null
  epic_no: string | null
  family_head_epic: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
  section_name: string | null
  gender: string | null
  religion: string | null
  state: string | null
  age: number | null
  contact_no_1: string | null
  voter_category: string | null
}

function familySizeBucket(count: number): string {
  return count >= 7 ? '7+' : String(count)
}

function getAgeBand(age: number | null): string {
  if (age === null || age < 18) return 'Unknown/Under 18'
  if (age <= 25) return '18-25'
  if (age <= 35) return '26-35'
  if (age <= 45) return '36-45'
  if (age <= 60) return '46-60'
  return '60+'
}

function categoryLabel(value: string | null | undefined): string {
  return voterCategoryLabel(value) ?? 'No category'
}

interface FamilyGroup {
  key: string
  head: VoterRow | null
  members: VoterRow[]
}

interface Agg {
  families: number
  voters: number
  male: number
  female: number
  avgSize: number
}

interface InsightNode {
  id: string
  label: string
  depth: number
  levelLabel: string
  agg: Agg
  children: InsightNode[]
}

/**
 * Family grouping - voters sharing the same family_head_epic belong to the
 * same family. A voter with a NULL family_head_epic is a single-member family
 * headed by itself. The head is the voter whose epic_no matches the group key.
 */
function buildFamilies(rows: VoterRow[]): FamilyGroup[] {
  const groups = new Map<string, VoterRow[]>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const key = normalizeLookupValue(row.family_head_epic) || normalizeLookupValue(row.epic_no) || `voter:${row.id}`
    const arr = groups.get(key)
    if (arr) arr.push(row)
    else groups.set(key, [row])
  }
  return Array.from(groups.entries()).map(([key, members]) => {
    const sorted = [...members].sort((a, b) => {
      const aIsHead = normalizeLookupValue(a.epic_no) === key
      const bIsHead = normalizeLookupValue(b.epic_no) === key
      if (aIsHead && !bIsHead) return -1
      if (!aIsHead && bIsHead) return 1
      return (a.name ?? '').localeCompare(b.name ?? '')
    })
    const head = sorted.find((m) => normalizeLookupValue(m.epic_no) === key) ?? sorted[0] ?? null
    return { key, head, members: sorted }
  })
}

function levelValue(level: LevelKey, family: FamilyGroup): string {
  const head = family.head ?? family.members[0] ?? null
  switch (level) {
    case 'part': return head?.part_no != null ? `Part ${head.part_no}` : 'Unknown Part'
    case 'section': return head?.section != null ? `Section ${head.section}` : 'Unknown Section'
    case 'sectionName': return (head?.section_name ?? '').trim() || 'Unknown Section Name'
    case 'ward': return head?.ward_no != null ? `Ward ${head.ward_no}` : 'Unknown Ward'
    case 'gender': return (head?.gender ?? '').trim() || 'Unknown Gender'
    case 'religion': return (head?.religion ?? '').trim() || 'Unknown Religion'
    case 'state': return (head?.state ?? '').trim() || 'Unknown State'
  }
}

function aggregate(families: FamilyGroup[]): Agg {
  let voters = 0
  let male = 0
  let female = 0
  for (const family of families) {
    for (const member of family.members) {
      voters += 1
      const gender = (member.gender ?? '').toLowerCase()
      if (gender === 'male') male += 1
      else if (gender === 'female') female += 1
    }
  }
  return {
    families: families.length,
    voters,
    male,
    female,
    avgSize: families.length ? voters / families.length : 0,
  }
}

function countMember(acc: MatrixAcc, member: VoterRow): void {
  const gender = (member.gender ?? '').toLowerCase()
  if (gender === 'male') acc.male += 1
  else if (gender === 'female') acc.female += 1
  else acc.other += 1
  if ((member.contact_no_1 ?? '').trim()) acc.contact += 1
}

function matrixMemberValue(member: VoterRow, dim: MatrixDimension): string {
  switch (dim) {
    case 'religion':
      return (member.religion ?? '').trim() || 'Unknown Religion'
    case 'state':
      return (member.state ?? '').trim() || 'Unknown State'
    case 'part':
      return member.part_no != null ? `Part ${member.part_no}` : 'Unassigned'
    case 'section':
      return member.section != null ? `Section ${member.section}` : 'Unassigned'
    case 'category':
      return categoryLabel(member.voter_category)
    case 'ageBand':
      return getAgeBand(member.age)
  }
}

function buildMatrix(members: VoterRow[], rowDim: MatrixDimension, subDim: MatrixDimension | null, maxRows: number): MatrixRow[] {
  const top = new Map<string, { acc: MatrixAcc; children: Map<string, MatrixAcc> }>()
  for (const member of members) {
    const topKey = matrixMemberValue(member, rowDim)
    let entry = top.get(topKey)
    if (!entry) {
      entry = { acc: { male: 0, female: 0, other: 0, contact: 0 }, children: new Map() }
      top.set(topKey, entry)
    }
    countMember(entry.acc, member)
    if (subDim) {
      const subKey = matrixMemberValue(member, subDim)
      let child = entry.children.get(subKey)
      if (!child) {
        child = { male: 0, female: 0, other: 0, contact: 0 }
        entry.children.set(subKey, child)
      }
      countMember(child, member)
    }
  }

  const toRow = (label: string, acc: MatrixAcc, dimension: MatrixDimension, children: MatrixRow[] = []): MatrixRow => {
    const total = acc.male + acc.female + acc.other
    return {
      id: `${dimension}:${label}`,
      label,
      dimension,
      male: acc.male,
      female: acc.female,
      other: acc.other,
      total,
      femalePct: total ? (acc.female / total) * 100 : 0,
      contactPct: total ? (acc.contact / total) * 100 : 0,
      children,
    }
  }

  const buildChildren = (children: Map<string, MatrixAcc>): MatrixRow[] => {
    if (!subDim) return []
    return Array.from(children.entries())
      .map(([label, child]) => toRow(label, child, subDim))
      .sort((a, b) => b.total - a.total)
  }

  const sorted = Array.from(top.entries()).sort((a, b) => {
    const at = a[1].acc.male + a[1].acc.female + a[1].acc.other
    const bt = b[1].acc.male + b[1].acc.female + b[1].acc.other
    return bt - at
  })

  const rows: MatrixRow[] = []
  if (maxRows > 0 && sorted.length > maxRows) {
    for (const [label, entry] of sorted.slice(0, maxRows - 1)) {
      rows.push(toRow(label, entry.acc, rowDim, buildChildren(entry.children)))
    }
    const rest: MatrixAcc = { male: 0, female: 0, other: 0, contact: 0 }
    for (const [, entry] of sorted.slice(maxRows - 1)) {
      rest.male += entry.acc.male
      rest.female += entry.acc.female
      rest.other += entry.acc.other
      rest.contact += entry.acc.contact
    }
    rows.push(toRow('Others', rest, rowDim))
  } else {
    for (const [label, entry] of sorted) {
      rows.push(toRow(label, entry.acc, rowDim, buildChildren(entry.children)))
    }
  }
  return rows
}

function buildTree(families: FamilyGroup[], levels: LevelKey[], depth: number, parentId: string): InsightNode[] {
  if (depth >= levels.length || families.length === 0) return []
  const level = levels[depth]
  const groups = new Map<string, FamilyGroup[]>()
  for (const family of families) {
    const value = levelValue(level, family)
    const arr = groups.get(value)
    if (arr) arr.push(family)
    else groups.set(value, [family])
  }
  const nodes: InsightNode[] = []
  for (const [value, groupFamilies] of groups) {
    const id = parentId ? `${parentId}::${value}` : value
    nodes.push({
      id,
      label: value,
      depth,
      levelLabel: LEVEL_LABELS[level],
      agg: aggregate(groupFamilies),
      children: buildTree(groupFamilies, levels, depth + 1, id),
    })
  }
  nodes.sort((a, b) => a.label.localeCompare(b.label))
  return nodes
}

function collectNodeIds(nodes: InsightNode[]): string[] {
  const ids: string[] = []
  for (const node of nodes) {
    ids.push(node.id)
    ids.push(...collectNodeIds(node.children))
  }
  return ids
}

interface NumberTableColumn<T> {
  key: string
  label: string
  className?: string
  cellClassName?: string
  render: (row: T) => React.ReactNode
}

interface NumberTableProps<T> {
  columns: NumberTableColumn<T>[]
  rows: T[]
  emptyMessage?: string
}

type PrintTarget = 'all' | 'familySize' | 'ageBands' | 'categories' | 'matrix' | 'religion' | 'genderPart' | 'dataQuality' | 'hierarchy'

const PRINT_TARGET_TITLES: Record<PrintTarget, string> = {
  all: 'Insights',
  familySize: 'Family Size Distribution',
  ageBands: 'Age Bands',
  categories: 'Category Counts',
  matrix: 'Demographics Matrix',
  religion: 'Religion by Part',
  genderPart: 'Gender by Part',
  dataQuality: 'Data Quality',
  hierarchy: 'Voter & Family Analysis',
}

interface InsightPrintSection {
  title: string
  fields: ReportFieldDef<Record<string, string>>[]
  rows: Array<Record<string, string>>
}

function printFields(defs: Array<{ key: string; label: string }>): ReportFieldDef<Record<string, string>>[] {
  return defs.map((def) => ({ key: def.key, label: def.label, getValue: (row) => row[def.key] ?? '' }))
}

function flattenMatrixForPrint(nodes: MatrixRow[]): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  const walk = (list: MatrixRow[], depth: number) => {
    for (const node of list) {
      out.push({
        group: `${'  '.repeat(depth)}${node.label}`,
        male: String(node.male),
        female: String(node.female),
        other: String(node.other),
        total: String(node.total),
        femalePct: `${node.femalePct.toFixed(1)}%`,
        contactPct: `${node.contactPct.toFixed(1)}%`,
      })
      walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return out
}

function flattenHierarchyForPrint(nodes: InsightNode[]): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  const walk = (list: InsightNode[]) => {
    for (const node of list) {
      out.push({
        level: node.levelLabel,
        value: node.label,
        families: String(node.agg.families),
        voters: String(node.agg.voters),
        male: String(node.agg.male),
        female: String(node.agg.female),
        avgSize: node.agg.avgSize.toFixed(1),
      })
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

function appendPrintSection(baseHtml: string, extraHtml: string): string {
  const bodyStart = extraHtml.indexOf('<body>')
  const bodyEnd = extraHtml.indexOf('</body>')
  const extraBody = bodyStart >= 0 && bodyEnd > bodyStart ? extraHtml.slice(bodyStart + 6, bodyEnd) : extraHtml
  return baseHtml.replace('</body>', `${extraBody}</body>`)
}

function PrintTableButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Printer className="h-3.5 w-3.5" /> Print
    </button>
  )
}

function NumberTable<T>({ columns, rows, emptyMessage }: NumberTableProps<T>) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0 text-sm">
        <thead className="bg-[#f7f9fd]">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`border-b border-line px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary ${column.className ?? ''}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-6 py-10 text-center text-sm text-ink-tertiary">
                {emptyMessage ?? 'No data available.'}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={index} className="transition hover:bg-[#f5f7fd]">
                {columns.map((column) => (
                  <td key={column.key} className={`border-b border-line px-4 py-2.5 tabular-nums ${column.cellClassName ?? ''}`}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export function InsightsPage() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<VoterRow[]>([])
  const [loading, setLoading] = useState(false)
  const [wardFilter, setWardFilter] = usePersistentState('vote:insights:wardFilter', 'all')
  const [partFilter, setPartFilter] = usePersistentState('vote:insights:partFilter', 'all')
  const [sectionFilter, setSectionFilter] = usePersistentState('vote:insights:sectionFilter', 'all')
  const [religionFilter, setReligionFilter] = usePersistentState('vote:insights:religionFilter', 'all')
  const [genderFilter, setGenderFilter] = usePersistentState('vote:insights:genderFilter', 'all')
  const [stateFilter, setStateFilter] = usePersistentState('vote:insights:stateFilter', 'all')
  const [categoryFilter, setCategoryFilter] = usePersistentState('vote:insights:categoryFilter', 'all')
  useEffect(() => {
    const migrated = migrateRetiredCategoryFilter(categoryFilter, 'all')
    if (migrated !== categoryFilter) setCategoryFilter(migrated)
  }, [categoryFilter, setCategoryFilter])
  const [ageBandFilter, setAgeBandFilter] = usePersistentState('vote:insights:ageBandFilter', 'all')
  const [query, setQuery] = usePersistentState('vote:insights:query', '')
  const [levels, setLevels] = usePersistentState<Array<LevelKey | ''>>('vote:insights:levels', ['part', 'section', '', ''])
  const [matrixRowDim, setMatrixRowDim] = usePersistentState<MatrixDimension>('vote:insights:matrixRowDim', 'religion')
  const [matrixSubDim, setMatrixSubDim] = usePersistentState<MatrixDimension | ''>('vote:insights:matrixSubDim', '')
  const [matrixMaxRows, setMatrixMaxRows] = usePersistentState<number>('vote:insights:matrixMaxRows', 10)
  const [religionShowSection, setReligionShowSection] = usePersistentState<boolean>('vote:insights:religionShowSection', false)
  const [printFontSize, setPrintFontSize] = usePersistentState<number>('vote:insights:printFontSize:v2', 20)
  const [printBold, setPrintBold] = usePersistentState<boolean>('vote:insights:printBold', false)
  const [printTarget, setPrintTarget] = useState<PrintTarget | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [matrixExpanded, setMatrixExpanded] = useState<Set<string>>(new Set())

  const activeLevels = levels.filter((level): level is LevelKey => level !== '')
  const levelsSignature = activeLevels.join('>')

  useEffect(() => {
    setExpanded(new Set())
  }, [levelsSignature])

  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)
  const cacheScope = useMemo(
    () => `${wardScope}|${wardFilter}|${partFilter}|${sectionFilter}|${religionFilter}|${genderFilter}|${stateFilter}|${categoryFilter}|${levelsSignature}`,
    [categoryFilter, genderFilter, levelsSignature, partFilter, religionFilter, sectionFilter, stateFilter, wardFilter, wardScope],
  )

  const load = useCallback(async (silent = false) => {
    const cachedRows = withNormalizedVoterCategories(readCachedCollection<VoterRow>(INSIGHTS_CACHE_KEY, cacheScope, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
    setLoading(!cachedRows.length)

    const batchSize = 400
    let offset = 0
    const allRows: VoterRow[] = []
    let firstChunkRendered = Boolean(cachedRows.length)

    for (;;) {
      let request = supabase
        .from('voters')
        .select('id,name,epic_no,family_head_epic,ward_no,part_no,section,section_name,gender,religion,state,age,contact_no_1,voter_category')
        .order('part_no', { ascending: true, nullsFirst: true })
        .order('section', { ascending: true, nullsFirst: true })
        .range(offset, offset + batchSize - 1)

      if (wardFilter !== 'all') request = request.eq('ward_no', Number(wardFilter))
      if (partFilter !== 'all') request = request.eq('part_no', Number(partFilter))
      if (sectionFilter !== 'all') request = request.eq('section', Number(sectionFilter))
      if (religionFilter !== 'all') request = request.eq('religion', religionFilter)
      if (genderFilter !== 'all') request = request.eq('gender', genderFilter)
      if (stateFilter !== 'all') request = request.eq('state', stateFilter)
      if (categoryFilter !== 'all') request = request.eq('voter_category', categoryFilter)

      const { data, error } = await request
      if (error) {
        setLoading(false)
        if (!silent) toast.error(error.message)
        return
      }

      const chunk = withNormalizedVoterCategories((data as VoterRow[] | null) ?? [])
      allRows.push(...chunk)

      if (!firstChunkRendered && chunk.length) {
        setRows([...allRows])
        setLoading(false)
        firstChunkRendered = true
      }

      if (chunk.length < batchSize) break
      offset += batchSize
    }

    if (!firstChunkRendered) setLoading(false)
    setRows(allRows)
    writeCachedCollection<VoterRow>(INSIGHTS_CACHE_KEY, cacheScope, allRows)
    setLoading(false)
    if (!silent) toast.success(`Loaded ${allRows.length.toLocaleString()} voters for analysis.`)
  }, [cacheScope, categoryFilter, genderFilter, partFilter, religionFilter, sectionFilter, stateFilter, wardFilter])

  useEffect(() => {
    void load(true)
  }, [load])

  const wardOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.ward_no).filter((value): value is number => value !== null))).sort((a, b) => a - b),
    [rows],
  )
  const partOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.part_no).filter((value): value is number => value !== null))).sort((a, b) => a - b),
    [rows],
  )
  const sectionOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.section).filter((value): value is number => value !== null))).sort((a, b) => a - b),
    [rows],
  )
  const religionOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => (row.religion ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rows],
  )
  const genderOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => (row.gender ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rows],
  )
  const stateOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => (row.state ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rows],
  )
  const categoryOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.voter_category).filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b)),
    [rows],
  )

  const families = useMemo(() => buildFamilies(rows), [rows])

  // Filters apply on the family head so families are never split.
  const filteredFamilies = useMemo(() => {
    const search = query.trim().toLowerCase()
    return families.filter((family) => {
      const head = family.head ?? family.members[0] ?? null
      if (!head) return false
      if (wardFilter !== 'all' && head.ward_no !== Number(wardFilter)) return false
      if (partFilter !== 'all' && head.part_no !== Number(partFilter)) return false
      if (sectionFilter !== 'all' && head.section !== Number(sectionFilter)) return false
      if (religionFilter !== 'all' && (head.religion ?? '') !== religionFilter) return false
      if (genderFilter !== 'all' && (head.gender ?? '') !== genderFilter) return false
      if (stateFilter !== 'all' && (head.state ?? '') !== stateFilter) return false
      if (categoryFilter !== 'all' && (head.voter_category ?? '') !== categoryFilter) return false
      if (ageBandFilter !== 'all' && getAgeBand(head.age) !== ageBandFilter) return false
      if (search) {
        const text = `${head.name ?? ''} ${head.section_name ?? ''} ${head.religion ?? ''} ${head.state ?? ''}`.toLowerCase()
        if (!text.includes(search)) return false
      }
      return true
    })
  }, [ageBandFilter, categoryFilter, families, genderFilter, partFilter, query, religionFilter, sectionFilter, stateFilter, wardFilter])

  const totalAgg = useMemo(() => aggregate(filteredFamilies), [filteredFamilies])

  const familySizeRows = useMemo(() => {
    const map = new Map<string, { bucket: string; families: number; voters: number }>()
    for (const family of filteredFamilies) {
      const bucket = familySizeBucket(family.members.length)
      const existing = map.get(bucket)
      if (existing) {
        existing.families += 1
        existing.voters += family.members.length
      } else {
        map.set(bucket, { bucket, families: 1, voters: family.members.length })
      }
    }
    const total = filteredFamilies.length || 1
    return Array.from(map.values())
      .map((row) => ({ ...row, pct: (row.families / total) * 100 }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket, undefined, { numeric: true }))
  }, [filteredFamilies])

  const ageBandRows = useMemo(() => {
    const map = new Map<string, number>()
    for (const family of filteredFamilies) {
      for (const member of family.members) {
        const band = getAgeBand(member.age)
        map.set(band, (map.get(band) ?? 0) + 1)
      }
    }
    const total = totalAgg.voters || 1
    return Array.from(map.entries())
      .map(([label, count]) => ({ label, count, pct: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count)
  }, [filteredFamilies, totalAgg.voters])

  const categoryRows = useMemo(() => {
    const map = new Map<string, number>()
    for (const family of filteredFamilies) {
      for (const member of family.members) {
        const label = categoryLabel(member.voter_category)
        map.set(label, (map.get(label) ?? 0) + 1)
      }
    }
    const total = totalAgg.voters || 1
    return Array.from(map.entries())
      .map(([label, count]) => ({ label, count, pct: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count)
  }, [filteredFamilies, totalAgg.voters])

  const genderPartMatrix = useMemo(() => {
    const partRows = new Map<string, { part: string; male: number; female: number; other: number }>()
    for (const family of filteredFamilies) {
      for (const member of family.members) {
        const part = member.part_no != null ? `Part ${member.part_no}` : 'Unassigned'
        const row = partRows.get(part) ?? { part, male: 0, female: 0, other: 0 }
        const gender = (member.gender ?? '').toLowerCase()
        if (gender === 'male') row.male += 1
        else if (gender === 'female') row.female += 1
        else row.other += 1
        partRows.set(part, row)
      }
    }
    return Array.from(partRows.values())
      .map((row) => ({ ...row, total: row.male + row.female + row.other }))
      .sort((a, b) => a.part.localeCompare(b.part, undefined, { numeric: true }))
  }, [filteredFamilies])

  const religionPartRows = useMemo(() => {
    const rowsByKey = new Map<string, ReligionPartRow>()
    for (const family of filteredFamilies) {
      for (const member of family.members) {
        const part = member.part_no != null ? `Part ${member.part_no}` : 'Unassigned'
        const section = member.section != null ? `Section ${member.section}` : 'Unassigned'
        const key = religionShowSection ? `${part}::${section}` : part
        const row = rowsByKey.get(key) ?? {
          key,
          part,
          section: religionShowSection ? section : '',
          hindu: 0,
          muslim: 0,
          catholic: 0,
          other: 0,
          total: 0,
        }
        row[classifyReligion(member.religion)] += 1
        row.total += 1
        rowsByKey.set(key, row)
      }
    }
    return Array.from(rowsByKey.values()).sort((a, b) => {
      const partCmp = a.part.localeCompare(b.part, undefined, { numeric: true })
      if (partCmp !== 0) return partCmp
      return a.section.localeCompare(b.section, undefined, { numeric: true })
    })
  }, [filteredFamilies, religionShowSection])

  const religionPartTotal = useMemo(() => {
    const total: Omit<ReligionPartRow, 'key' | 'part' | 'section'> = {
      hindu: 0,
      muslim: 0,
      catholic: 0,
      other: 0,
      total: 0,
    }
    for (const row of religionPartRows) {
      total.hindu += row.hindu
      total.muslim += row.muslim
      total.catholic += row.catholic
      total.other += row.other
      total.total += row.total
    }
    return total
  }, [religionPartRows])

  const allMembers = useMemo(() => filteredFamilies.flatMap((family) => family.members), [filteredFamilies])

  const matrixRows = useMemo(
    () => buildMatrix(allMembers, matrixRowDim, matrixSubDim || null, matrixMaxRows),
    [allMembers, matrixMaxRows, matrixRowDim, matrixSubDim],
  )

  const matrixTotal = useMemo(() => {
    const acc: MatrixAcc = { male: 0, female: 0, other: 0, contact: 0 }
    for (const member of allMembers) countMember(acc, member)
    const total = acc.male + acc.female + acc.other
    return { ...acc, total }
  }, [allMembers])

  const dataQualityStats = useMemo(() => {
    let singleMemberFamilies = 0
    let missingHeadFamilies = 0
    let voters = 0
    let votersWithContact = 0
    let missingGender = 0
    let missingReligion = 0
    for (const family of filteredFamilies) {
      if (family.members.length === 1) singleMemberFamilies += 1
      const groupKey = normalizeLookupValue(family.key)
      if (!family.members.some((member) => normalizeLookupValue(member.epic_no) === groupKey)) missingHeadFamilies += 1
      for (const member of family.members) {
        voters += 1
        if ((member.contact_no_1 ?? '').trim()) votersWithContact += 1
        if (!(member.gender ?? '').trim()) missingGender += 1
        if (!(member.religion ?? '').trim()) missingReligion += 1
      }
    }
    const familyTotal = filteredFamilies.length || 1
    const voterTotal = voters || 1
    return {
      singleMemberFamilies,
      singleMemberPct: (singleMemberFamilies / familyTotal) * 100,
      missingHeadFamilies,
      missingHeadPct: (missingHeadFamilies / familyTotal) * 100,
      voters,
      votersWithContact,
      votersWithoutContact: voters - votersWithContact,
      noContactPct: ((voters - votersWithContact) / voterTotal) * 100,
      missingGender,
      missingGenderPct: (missingGender / voterTotal) * 100,
      missingReligion,
      missingReligionPct: (missingReligion / voterTotal) * 100,
    }
  }, [filteredFamilies])

  const dataQualityRows = useMemo(
    () => [
      { label: 'Single-member families', count: dataQualityStats.singleMemberFamilies, pct: dataQualityStats.singleMemberPct },
      { label: 'Families with missing head voter', count: dataQualityStats.missingHeadFamilies, pct: dataQualityStats.missingHeadPct },
      { label: 'Voters without a contact number', count: dataQualityStats.votersWithoutContact, pct: dataQualityStats.noContactPct },
      { label: 'Voters missing gender', count: dataQualityStats.missingGender, pct: dataQualityStats.missingGenderPct },
      { label: 'Voters missing religion', count: dataQualityStats.missingReligion, pct: dataQualityStats.missingReligionPct },
    ],
    [dataQualityStats],
  )

  const tree = useMemo(() => buildTree(filteredFamilies, activeLevels, 0, ''), [filteredFamilies, activeLevels])

  const toggleNode = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAll = () => setExpanded(new Set(collectNodeIds(tree)))
  const collapseAll = () => setExpanded(new Set())

  const setLevel = (index: number, value: LevelKey | '') => {
    setLevels((prev) => prev.map((level, i) => (i === index ? value : level)))
  }

  const renderNode = (node: InsightNode, parentExpanded: boolean): React.ReactNode => {
    if (node.depth > 0 && !parentExpanded) return null
    const hasChildren = node.children.length > 0
    const isExpanded = expanded.has(node.id)
    const cellClass = 'border-b border-line px-4 py-2.5 tabular-nums'
    return (
      <Fragment key={node.id}>
        <tr className="transition hover:bg-[#f5f7fd]">
          <td className={`${cellClass} text-ink-secondary`} style={{ paddingLeft: `${12 + node.depth * 22}px` }}>
            <div className="flex items-center gap-1.5">
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => toggleNode(node.id)}
                  className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-ink-tertiary transition hover:bg-muted"
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              ) : (
                <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center">
                  <ChevronRight className="h-4 w-4 opacity-0" />
                </span>
              )}
              <span className={node.depth === 0 ? 'font-bold text-ink' : 'font-medium text-ink'}>{node.label}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">{node.levelLabel}</span>
            </div>
          </td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{node.agg.families}</td>
          <td className={`${cellClass} text-right font-semibold text-ink`}>{node.agg.voters}</td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{node.agg.male}</td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{node.agg.female}</td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{node.agg.avgSize.toFixed(1)}</td>
        </tr>
        {hasChildren && isExpanded ? node.children.map((child) => renderNode(child, isExpanded)) : null}
      </Fragment>
    )
  }

  const drillMatrixRow = (row: MatrixRow) => {
    if (row.label === 'Others') return
    switch (row.dimension) {
      case 'religion':
        setReligionFilter(row.label)
        break
      case 'state':
        setStateFilter(row.label)
        break
      case 'part': {
        const part = parseInt(row.label.replace(/^Part /, ''), 10)
        if (!Number.isNaN(part)) setPartFilter(String(part))
        break
      }
      case 'section': {
        const section = parseInt(row.label.replace(/^Section /, ''), 10)
        if (!Number.isNaN(section)) setSectionFilter(String(section))
        break
      }
      case 'category': {
        const option = VOTER_CATEGORY_OPTIONS.find((category) => category.label === row.label)
        setCategoryFilter(option?.value ?? row.label)
        break
      }
      case 'ageBand':
        setAgeBandFilter(row.label)
        break
    }
  }

  const collectMatrixIds = (nodes: MatrixRow[]): string[] => {
    const ids: string[] = []
    for (const node of nodes) {
      ids.push(node.id)
      ids.push(...collectMatrixIds(node.children))
    }
    return ids
  }

  const expandMatrixAll = () => setMatrixExpanded(new Set(collectMatrixIds(matrixRows)))
  const collapseMatrixAll = () => setMatrixExpanded(new Set())

  const renderMatrixRow = (row: MatrixRow, depth: number, parentExpanded: boolean): React.ReactNode => {
    if (depth > 0 && !parentExpanded) return null
    const hasChildren = row.children.length > 0
    const isExpanded = matrixExpanded.has(row.id)
    const cellClass = 'border-b border-line px-4 py-2.5 tabular-nums'
    const malePct = row.total ? (row.male / row.total) * 100 : 0
    const femalePct = row.total ? (row.female / row.total) * 100 : 0
    const otherPct = Math.max(0, 100 - malePct - femalePct)
    return (
      <Fragment key={row.id}>
        <tr className="transition hover:bg-[#f5f7fd]">
          <td className={`${cellClass} text-ink-secondary`} style={{ paddingLeft: `${12 + depth * 22}px` }}>
            <div className="flex items-center gap-1.5">
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => {
                    setMatrixExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(row.id)) next.delete(row.id)
                      else next.add(row.id)
                      return next
                    })
                  }}
                  className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-ink-tertiary transition hover:bg-muted"
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              ) : (
                <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center">
                  <ChevronRight className="h-4 w-4 opacity-0" />
                </span>
              )}
              {row.label === 'Others' ? (
                <span className="font-medium text-ink">{row.label}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => drillMatrixRow(row)}
                  className="rounded text-left font-medium text-brand-600 transition hover:text-brand-700 hover:underline"
                  title={`Filter by ${row.label}`}
                >
                  {row.label}
                </button>
              )}
            </div>
          </td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{row.male.toLocaleString()}</td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{row.female.toLocaleString()}</td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{row.other.toLocaleString()}</td>
          <td className={`${cellClass} text-right font-semibold text-ink`}>{row.total.toLocaleString()}</td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{row.femalePct.toFixed(1)}%</td>
          <td className={`${cellClass} text-right text-ink-secondary`}>{row.contactPct.toFixed(1)}%</td>
          <td className={`${cellClass}`}>
            <div
              className="flex h-2 w-24 overflow-hidden rounded-full bg-muted"
              title={`Male ${malePct.toFixed(1)}% · Female ${femalePct.toFixed(1)}% · Other ${otherPct.toFixed(1)}%`}
            >
              {malePct > 0 && <div className="bg-sky-500" style={{ width: `${malePct}%` }} />}
              {femalePct > 0 && <div className="bg-rose-400" style={{ width: `${femalePct}%` }} />}
              {otherPct > 0 && <div className="bg-slate-400" style={{ width: `${otherPct}%` }} />}
            </div>
          </td>
        </tr>
        {hasChildren && isExpanded ? row.children.map((child) => renderMatrixRow(child, depth + 1, isExpanded)) : null}
      </Fragment>
    )
  }

  const exportAnalysis = () => {
    const workbook = XLSX.utils.book_new()

    const hierarchyRows: Array<Array<string | number>> = [['Level', 'Value', 'Families', 'Voters', 'Male', 'Female', 'Avg Family Size']]
    hierarchyRows.push(['Grand Total', '', totalAgg.families, totalAgg.voters, totalAgg.male, totalAgg.female, Number(totalAgg.avgSize.toFixed(1))])
    const walk = (nodes: InsightNode[]) => {
      for (const node of nodes) {
        hierarchyRows.push([node.levelLabel, node.label, node.agg.families, node.agg.voters, node.agg.male, node.agg.female, Number(node.agg.avgSize.toFixed(1))])
        walk(node.children)
      }
    }
    walk(tree)
    const hierarchySheet = XLSX.utils.aoa_to_sheet(hierarchyRows)
    hierarchySheet['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 12 }]
    XLSX.utils.book_append_sheet(workbook, hierarchySheet, 'Hierarchy')

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Family Size', 'Families', 'Voters', '% of Families'],
        ...familySizeRows.map((row) => [row.bucket, row.families, row.voters, Number(row.pct.toFixed(1))]),
      ]),
      'Family Sizes',
    )

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Age Band', 'Voters', '% of Voters'],
        ...ageBandRows.map((row) => [row.label, row.count, Number(row.pct.toFixed(1))]),
      ]),
      'Age Bands',
    )

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Category', 'Voters', '% of Voters'],
        ...categoryRows.map((row) => [row.label, row.count, Number(row.pct.toFixed(1))]),
      ]),
      'Categories',
    )

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Part', 'Male', 'Female', 'Other', 'Total'],
        ...genderPartMatrix.map((row) => [row.part, row.male, row.female, row.other, row.total]),
      ]),
      'Gender by Part',
    )

    const religionHeaders = religionShowSection
      ? ['Part', 'Section', 'Hindu', 'Muslim', 'Catholic', 'Other', 'Total']
      : ['Part', 'Hindu', 'Muslim', 'Catholic', 'Other', 'Total']
    const religionExportRows = religionPartRows.map((row) => (
      religionShowSection
        ? [row.part, row.section, row.hindu, row.muslim, row.catholic, row.other, row.total]
        : [row.part, row.hindu, row.muslim, row.catholic, row.other, row.total]
    ))
    const religionTotalRow = religionShowSection
      ? ['Grand Total', '', religionPartTotal.hindu, religionPartTotal.muslim, religionPartTotal.catholic, religionPartTotal.other, religionPartTotal.total]
      : ['Grand Total', religionPartTotal.hindu, religionPartTotal.muslim, religionPartTotal.catholic, religionPartTotal.other, religionPartTotal.total]
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        religionHeaders,
        religionTotalRow,
        ...religionExportRows,
      ]),
      'Religion by Part',
    )

    const flattenMatrix = (nodes: MatrixRow[], depth: number, out: Array<Array<string | number>>) => {
      for (const node of nodes) {
        out.push([`${'  '.repeat(depth)}${node.label}`, node.male, node.female, node.other, node.total, Number(node.femalePct.toFixed(1)), Number(node.contactPct.toFixed(1))])
        flattenMatrix(node.children, depth + 1, out)
      }
    }
    const matrixOut: Array<Array<string | number>> = []
    flattenMatrix(matrixRows, 0, matrixOut)
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Group', 'Male', 'Female', 'Other', 'Total', 'Female %', 'Has Contact %'],
        ['Grand Total', matrixTotal.male, matrixTotal.female, matrixTotal.other, matrixTotal.total, Number(((matrixTotal.total ? matrixTotal.female / matrixTotal.total : 0) * 100).toFixed(1)), Number(((matrixTotal.total ? matrixTotal.contact / matrixTotal.total : 0) * 100).toFixed(1))],
        ...matrixOut,
      ]),
      'Demographics Matrix',
    )

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Metric', 'Count', '% of Scope'],
        ...dataQualityRows.map((row) => [row.label, row.count, Number(row.pct.toFixed(1))]),
      ]),
      'Data Quality',
    )

    XLSX.writeFile(workbook, `insights-analysis-${new Date().toISOString().slice(0, 10)}.xlsx`)
    toast.success('Analysis exported.')
  }

  const printFilterMeta = useMemo(() => {
    const parts = [
      `${filteredFamilies.length.toLocaleString()} families`,
      `${totalAgg.voters.toLocaleString()} voters`,
    ]
    if (wardFilter !== 'all') parts.push(`Ward ${wardFilter}`)
    if (partFilter !== 'all') parts.push(`Part ${partFilter}`)
    if (sectionFilter !== 'all') parts.push(`Section ${sectionFilter}`)
    if (religionFilter !== 'all') parts.push(religionFilter)
    if (genderFilter !== 'all') parts.push(genderFilter)
    if (stateFilter !== 'all') parts.push(stateFilter)
    if (categoryFilter !== 'all') parts.push(categoryLabel(categoryFilter))
    if (ageBandFilter !== 'all') parts.push(ageBandFilter)
    return parts.join(' · ')
  }, [ageBandFilter, categoryFilter, filteredFamilies.length, genderFilter, partFilter, religionFilter, sectionFilter, stateFilter, totalAgg.voters, wardFilter])

  const buildPrintSections = (target: PrintTarget): InsightPrintSection[] => {
    const sections: InsightPrintSection[] = []

    if (target === 'all' || target === 'familySize') {
      sections.push({
        title: 'Family Size Distribution',
        fields: printFields([
          { key: 'size', label: 'Family Size' },
          { key: 'families', label: 'Families' },
          { key: 'voters', label: 'Voters' },
          { key: 'pct', label: '% of Families' },
        ]),
        rows: familySizeRows.map((row) => ({
          size: row.bucket === '1' ? 'Single (1 member)' : `${row.bucket} members`,
          families: String(row.families),
          voters: String(row.voters),
          pct: `${row.pct.toFixed(1)}%`,
        })),
      })
    }

    if (target === 'all' || target === 'ageBands') {
      sections.push({
        title: 'Age Bands',
        fields: printFields([
          { key: 'band', label: 'Age Band' },
          { key: 'count', label: 'Voters' },
          { key: 'pct', label: '% of Voters' },
        ]),
        rows: ageBandRows.map((row) => ({
          band: row.label,
          count: String(row.count),
          pct: `${row.pct.toFixed(1)}%`,
        })),
      })
    }

    if (target === 'all' || target === 'categories') {
      sections.push({
        title: 'Category Counts',
        fields: printFields([
          { key: 'category', label: 'Category' },
          { key: 'count', label: 'Voters' },
          { key: 'pct', label: '% of Voters' },
        ]),
        rows: categoryRows.map((row) => ({
          category: row.label,
          count: String(row.count),
          pct: `${row.pct.toFixed(1)}%`,
        })),
      })
    }

    if (target === 'all' || target === 'matrix') {
      const femalePct = matrixTotal.total ? (matrixTotal.female / matrixTotal.total) * 100 : 0
      const contactPct = matrixTotal.total ? (matrixTotal.contact / matrixTotal.total) * 100 : 0
      sections.push({
        title: matrixSubDim
          ? `Demographics Matrix · ${MATRIX_DIMENSION_LABELS[matrixRowDim]} by ${MATRIX_DIMENSION_LABELS[matrixSubDim]}`
          : `Demographics Matrix · ${MATRIX_DIMENSION_LABELS[matrixRowDim]}`,
        fields: printFields([
          { key: 'group', label: MATRIX_DIMENSION_LABELS[matrixRowDim] },
          { key: 'male', label: 'Male' },
          { key: 'female', label: 'Female' },
          { key: 'other', label: 'Other' },
          { key: 'total', label: 'Total' },
          { key: 'femalePct', label: 'Female %' },
          { key: 'contactPct', label: 'Has Contact %' },
        ]),
        rows: [
          {
            group: 'Grand Total',
            male: String(matrixTotal.male),
            female: String(matrixTotal.female),
            other: String(matrixTotal.other),
            total: String(matrixTotal.total),
            femalePct: `${femalePct.toFixed(1)}%`,
            contactPct: `${contactPct.toFixed(1)}%`,
          },
          ...flattenMatrixForPrint(matrixRows),
        ],
      })
    }

    if (target === 'all' || target === 'religion') {
      const religionFields = printFields([
        { key: 'part', label: 'Part' },
        ...(religionShowSection ? [{ key: 'section', label: 'Section' }] : []),
        { key: 'hindu', label: 'Hindu' },
        { key: 'muslim', label: 'Muslim' },
        { key: 'catholic', label: 'Catholic' },
        { key: 'other', label: 'Other' },
        { key: 'total', label: 'Total' },
      ])
      sections.push({
        title: religionShowSection ? 'Religion by Part and Section' : 'Religion by Part',
        fields: religionFields,
        rows: [
          {
            part: 'Grand Total',
            section: '',
            hindu: String(religionPartTotal.hindu),
            muslim: String(religionPartTotal.muslim),
            catholic: String(religionPartTotal.catholic),
            other: String(religionPartTotal.other),
            total: String(religionPartTotal.total),
          },
          ...religionPartRows.map((row) => ({
            part: row.part,
            section: row.section,
            hindu: String(row.hindu),
            muslim: String(row.muslim),
            catholic: String(row.catholic),
            other: String(row.other),
            total: String(row.total),
          })),
        ],
      })
    }

    if (target === 'all' || target === 'genderPart') {
      const genderTotal = genderPartMatrix.reduce(
        (acc, row) => ({
          male: acc.male + row.male,
          female: acc.female + row.female,
          other: acc.other + row.other,
          total: acc.total + row.total,
        }),
        { male: 0, female: 0, other: 0, total: 0 },
      )
      sections.push({
        title: 'Gender by Part',
        fields: printFields([
          { key: 'part', label: 'Part' },
          { key: 'male', label: 'Male' },
          { key: 'female', label: 'Female' },
          { key: 'other', label: 'Other' },
          { key: 'total', label: 'Total' },
        ]),
        rows: [
          {
            part: 'Grand Total',
            male: String(genderTotal.male),
            female: String(genderTotal.female),
            other: String(genderTotal.other),
            total: String(genderTotal.total),
          },
          ...genderPartMatrix.map((row) => ({
            part: row.part,
            male: String(row.male),
            female: String(row.female),
            other: String(row.other),
            total: String(row.total),
          })),
        ],
      })
    }

    if (target === 'all' || target === 'dataQuality') {
      sections.push({
        title: 'Data Quality',
        fields: printFields([
          { key: 'metric', label: 'Metric' },
          { key: 'count', label: 'Count' },
          { key: 'pct', label: '% of Scope' },
        ]),
        rows: dataQualityRows.map((row) => ({
          metric: row.label,
          count: String(row.count),
          pct: `${row.pct.toFixed(1)}%`,
        })),
      })
    }

    if (target === 'all' || target === 'hierarchy') {
      sections.push({
        title: 'Voter & Family Analysis',
        fields: printFields([
          { key: 'level', label: 'Level' },
          { key: 'value', label: 'Value' },
          { key: 'families', label: 'Families' },
          { key: 'voters', label: 'Voters' },
          { key: 'male', label: 'Male' },
          { key: 'female', label: 'Female' },
          { key: 'avgSize', label: 'Avg Size' },
        ]),
        rows: [
          {
            level: 'Grand Total',
            value: '',
            families: String(totalAgg.families),
            voters: String(totalAgg.voters),
            male: String(totalAgg.male),
            female: String(totalAgg.female),
            avgSize: totalAgg.avgSize.toFixed(1),
          },
          ...flattenHierarchyForPrint(tree),
        ],
      })
    }

    return sections.filter((section) => section.rows.length > 0)
  }

  const persistPrintStyle = (style: PrintStyleOptions) => {
    setPrintFontSize(style.fontSize)
    setPrintBold(style.boldText)
  }

  const executePrint = (target: PrintTarget, style: PrintStyleOptions) => {
    const sections = buildPrintSections(target)
    if (sections.length === 0) {
      toast.error('No data to print.')
      return
    }
    const first = sections[0]
    let html = buildPrintHtml({
      rows: first.rows,
      fields: first.fields,
      title: target === 'all' ? 'Insights' : first.title,
      meta: printFilterMeta,
    }, style)
    for (const section of sections.slice(1)) {
      const extra = buildPrintHtml({
        rows: section.rows,
        fields: section.fields,
        title: section.title,
        meta: '',
      }, style)
      html = appendPrintSection(html, extra)
    }
    openPrintWindow(html)
  }

  const executePdf = (target: PrintTarget, style: PrintStyleOptions) => {
    const sections = buildPrintSections(target)
    if (sections.length === 0) {
      toast.error('No data to print.')
      return
    }
    const maxCols = Math.max(...sections.map((section) => section.fields.length))
    const pad = (cells: string[]) => {
      const next = cells.slice(0, maxCols)
      while (next.length < maxCols) next.push('')
      return next
    }
    const headers = sections.length === 1
      ? sections[0].fields.map((field) => field.label)
      : pad(Array.from({ length: maxCols }, (_, index) => (index === 0 ? 'Table' : '')))
    const rows: string[][] = []
    sections.forEach((section, index) => {
      if (sections.length > 1) {
        if (index > 0) rows.push(pad(['']))
        rows.push(pad([section.title]))
        rows.push(pad(section.fields.map((field) => field.label)))
      }
      for (const row of section.rows) {
        rows.push(pad(section.fields.map((field) => field.getValue(row))))
      }
    })
    void downloadPdfTable({
      title: target === 'all' ? 'Insights' : PRINT_TARGET_TITLES[target],
      summary: [['Scope', printFilterMeta], ['Generated', new Date().toLocaleString()]],
      headers,
      rows,
      fontSize: style.fontSize,
      boldText: style.boldText,
      fileName: `insights-${target}-${new Date().toISOString().slice(0, 10)}.pdf`,
    })
  }

  const openPrint = (target: PrintTarget) => {
    if (buildPrintSections(target).length === 0) {
      toast.error('No data to print.')
      return
    }
    setPrintTarget(target)
  }

  const handlePrintConfirm = (_fields: unknown, _layout: boolean, style: PrintStyleOptions) => {
    if (!printTarget) return
    persistPrintStyle(style)
    const target = printTarget
    setPrintTarget(null)
    executePrint(target, style)
  }

  const handlePdfDownload = (_fields: unknown, _layout: boolean, style: PrintStyleOptions) => {
    if (!printTarget) return
    persistPrintStyle(style)
    const target = printTarget
    setPrintTarget(null)
    executePdf(target, style)
  }

  const numericCell = 'w-24 text-right'
  const selectClass = 'h-10 rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100'

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="Insights"
        description="Voter and family-wise analysis. Build a hierarchy of Parts, Sections, Wards and more - every figure is a plain count."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => openPrint('all')}
              disabled={filteredFamilies.length === 0}
            >
              <Printer className="h-4 w-4" /> Print All
            </Button>
            <Button
              onClick={exportAnalysis}
              disabled={filteredFamilies.length === 0}
            >
              <Download className="h-4 w-4" /> Export Analysis
            </Button>
          </div>
        }
      />

      <section className="sticky top-[4.5rem] z-20 rounded-xl border border-line bg-white/95 p-3 shadow-soft backdrop-blur-md">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-tertiary">Filters apply to the family head</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="h-10 min-w-[220px] flex-1 rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            placeholder="Search family head, section, religion, state..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          <select className={selectClass} value={wardFilter} aria-label="Filter by ward" onChange={(e) => setWardFilter(e.target.value)}>
            <option value="all">All Wards</option>
            {wardOptions.map((ward) => <option key={ward} value={String(ward)}>Ward {ward}</option>)}
          </select>

          <select className={selectClass} value={partFilter} aria-label="Filter by part" onChange={(e) => setPartFilter(e.target.value)}>
            <option value="all">All Parts</option>
            {partOptions.map((part) => <option key={part} value={String(part)}>Part {part}</option>)}
          </select>

          <select className={selectClass} value={sectionFilter} aria-label="Filter by section" onChange={(e) => setSectionFilter(e.target.value)}>
            <option value="all">All Sections</option>
            {sectionOptions.map((section) => <option key={section} value={String(section)}>Section {section}</option>)}
          </select>

          <select className={selectClass} value={genderFilter} aria-label="Filter by gender" onChange={(e) => setGenderFilter(e.target.value)}>
            <option value="all">All Genders</option>
            {genderOptions.map((gender) => <option key={gender} value={gender}>{gender}</option>)}
          </select>

          <select className={selectClass} value={religionFilter} aria-label="Filter by religion" onChange={(e) => setReligionFilter(e.target.value)}>
            <option value="all">All Religions</option>
            {religionOptions.map((religion) => <option key={religion} value={religion}>{religion}</option>)}
          </select>

          <select className={selectClass} value={stateFilter} aria-label="Filter by state" onChange={(e) => setStateFilter(e.target.value)}>
            <option value="all">All States</option>
            {stateOptions.map((state) => <option key={state} value={state}>{state}</option>)}
          </select>

          <select className={selectClass} value={categoryFilter} aria-label="Filter by category" onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="all">All Categories</option>
            {categoryOptions.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}
          </select>

          <select className={selectClass} value={ageBandFilter} aria-label="Filter by age band" onChange={(e) => setAgeBandFilter(e.target.value)}>
            <option value="all">All Age Bands</option>
            {AGE_BAND_OPTIONS.map((band) => <option key={band} value={band}>{band}</option>)}
          </select>

          <Button
            variant="secondary"
            size="compact"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {loading ? 'Loading...' : 'Reload'}
          </Button>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Families" value={filteredFamilies.length.toLocaleString()} featured tone="brand" />
        <StatCard title="Voters" value={totalAgg.voters.toLocaleString()} />
        <StatCard title="Male" value={totalAgg.male.toLocaleString()} tone="info" />
        <StatCard title="Female" value={totalAgg.female.toLocaleString()} tone="success" />
        <StatCard title="Avg Family Size" value={totalAgg.avgSize.toFixed(1)} />
        <StatCard title="Single-member" value={dataQualityStats.singleMemberFamilies.toLocaleString()} />
      </section>

      <section className="rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Family Size Distribution</h2>
            <p className="text-xs text-ink-tertiary">Families grouped by the number of members.</p>
          </div>
          <PrintTableButton onClick={() => openPrint('familySize')} disabled={familySizeRows.length === 0} />
        </div>
        <NumberTable
          columns={[
            { key: 'size', label: 'Family Size', render: (row) => <span className="font-medium text-ink">{row.bucket === '1' ? 'Single (1 member)' : `${row.bucket} members`}</span> },
            { key: 'families', label: 'Families', className: 'text-right', cellClassName: 'text-right', render: (row) => row.families.toLocaleString() },
            { key: 'voters', label: 'Voters', className: 'text-right', cellClassName: 'text-right', render: (row) => row.voters.toLocaleString() },
            { key: 'pct', label: '% of Families', className: 'text-right', cellClassName: 'text-right', render: (row) => (
              <span className="inline-flex items-center justify-end gap-2">
                <span>{row.pct.toFixed(1)}%</span>
                <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:inline-flex">
                  <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.min(row.pct, 100)}%` }} />
                </span>
              </span>
            ) },
          ]}
          rows={familySizeRows}
          emptyMessage="No families match the current filters."
        />
      </section>

      <section className="rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Age Bands</h2>
            <p className="text-xs text-ink-tertiary">Voter count by age group.</p>
          </div>
          <PrintTableButton onClick={() => openPrint('ageBands')} disabled={ageBandRows.length === 0} />
        </div>
        <NumberTable
          columns={[
            { key: 'band', label: 'Age Band', render: (row) => <span className="font-medium text-ink">{row.label}</span> },
            { key: 'count', label: 'Voters', className: 'text-right', cellClassName: 'text-right', render: (row) => row.count.toLocaleString() },
            { key: 'pct', label: '% of Voters', className: 'text-right', cellClassName: 'text-right', render: (row) => (
              <span className="inline-flex items-center justify-end gap-2">
                <span>{row.pct.toFixed(1)}%</span>
                <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:inline-flex">
                  <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.min(row.pct, 100)}%` }} />
                </span>
              </span>
            ) },
          ]}
          rows={ageBandRows}
          emptyMessage="No age data for the current filter."
        />
      </section>

      <section className="rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Category Counts</h2>
            <p className="text-xs text-ink-tertiary">Voter count by assigned category.</p>
          </div>
          <PrintTableButton onClick={() => openPrint('categories')} disabled={categoryRows.length === 0} />
        </div>
        <NumberTable
          columns={[
            { key: 'category', label: 'Category', render: (row) => <span className="font-medium text-ink">{row.label}</span> },
            { key: 'count', label: 'Voters', className: 'text-right', cellClassName: 'text-right', render: (row) => row.count.toLocaleString() },
            { key: 'pct', label: '% of Voters', className: 'text-right', cellClassName: 'text-right', render: (row) => (
              <span className="inline-flex items-center justify-end gap-2">
                <span>{row.pct.toFixed(1)}%</span>
                <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:inline-flex">
                  <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.min(row.pct, 100)}%` }} />
                </span>
              </span>
            ) },
          ]}
          rows={categoryRows}
          emptyMessage="No category data for the current filter."
        />
      </section>

      <section className="rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Demographics Matrix</h2>
            <p className="text-xs text-ink-tertiary">Cross-tab of any group by gender. Click a group to filter the whole page to it.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={expandMatrixAll} className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">Expand All</button>
            <button type="button" onClick={collapseMatrixAll} className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">Collapse All</button>
            <PrintTableButton onClick={() => openPrint('matrix')} disabled={matrixRows.length === 0} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <select
            className="h-10 rounded-xl border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            value={matrixRowDim}
            aria-label="Matrix row dimension"
            onChange={(e) => setMatrixRowDim(e.target.value as MatrixDimension)}
          >
            {MATRIX_DIMENSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span className="text-xs font-medium text-ink-tertiary">by</span>
          <select
            className="h-10 rounded-xl border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            value={matrixSubDim}
            aria-label="Matrix sub-dimension"
            onChange={(e) => setMatrixSubDim(e.target.value as MatrixDimension | '')}
          >
            <option value="">Section / no sub-group</option>
            {MATRIX_DIMENSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select
            className="h-10 rounded-xl border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            value={String(matrixMaxRows)}
            aria-label="Max rows before Others bucket"
            onChange={(e) => setMatrixMaxRows(Number(e.target.value))}
          >
            {[5, 10, 15, 20].map((count) => <option key={count} value={String(count)}>Top {count} + Others</option>)}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="bg-[#f7f9fd]">
              <tr>
                <th className="border-b border-line px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">{MATRIX_DIMENSION_LABELS[matrixRowDim]}</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Male</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Female</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Other</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Total</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Female %</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Has Contact %</th>
                <th className={`border-b border-line px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Gender Split</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-brand-50/40">
                <td className="border-b border-line px-4 py-3 font-bold text-ink">Grand Total</td>
                <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{matrixTotal.male.toLocaleString()}</td>
                <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{matrixTotal.female.toLocaleString()}</td>
                <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{matrixTotal.other.toLocaleString()}</td>
                <td className={`${numericCell} border-b border-line py-3 text-right font-bold text-ink`}>{matrixTotal.total.toLocaleString()}</td>
                <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{((matrixTotal.total ? matrixTotal.female / matrixTotal.total : 0) * 100).toFixed(1)}%</td>
                <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{((matrixTotal.total ? matrixTotal.contact / matrixTotal.total : 0) * 100).toFixed(1)}%</td>
                <td className="border-b border-line px-4 py-3" />
              </tr>
              {matrixRows.map((row) => renderMatrixRow(row, 0, true))}
              {matrixRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-sm text-ink-tertiary">
                    No data matches the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Religion by Part</h2>
            <p className="text-xs text-ink-tertiary">Hindu, Muslim, Catholic and Other voter counts per part.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-200"
                checked={religionShowSection}
                onChange={(event) => setReligionShowSection(event.target.checked)}
              />
              Show section
            </label>
            <PrintTableButton onClick={() => openPrint('religion')} disabled={religionPartRows.length === 0} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="bg-[#f7f9fd]">
              <tr>
                <th className="border-b border-line px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Part</th>
                {religionShowSection && (
                  <th className="border-b border-line px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">Section</th>
                )}
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Hindu</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Muslim</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Catholic</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Other</th>
                <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {religionPartRows.length === 0 ? (
                <tr>
                  <td colSpan={religionShowSection ? 7 : 6} className="px-6 py-10 text-center text-sm text-ink-tertiary">
                    No religion data for the current filter.
                  </td>
                </tr>
              ) : (
                <>
                  <tr className="bg-brand-50/40">
                    <td className="border-b border-line px-4 py-3 font-bold text-ink">Grand Total</td>
                    {religionShowSection && <td className="border-b border-line px-4 py-3" />}
                    <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{religionPartTotal.hindu.toLocaleString()}</td>
                    <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{religionPartTotal.muslim.toLocaleString()}</td>
                    <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{religionPartTotal.catholic.toLocaleString()}</td>
                    <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{religionPartTotal.other.toLocaleString()}</td>
                    <td className={`${numericCell} border-b border-line py-3 text-right font-bold text-ink`}>{religionPartTotal.total.toLocaleString()}</td>
                  </tr>
                  {religionPartRows.map((row) => (
                    <tr key={row.key} className="transition hover:bg-[#f5f7fd]">
                      <td className="border-b border-line px-4 py-2.5 font-medium text-ink">{row.part}</td>
                      {religionShowSection && (
                        <td className="border-b border-line px-4 py-2.5 text-ink-secondary">{row.section}</td>
                      )}
                      <td className={`${numericCell} border-b border-line py-2.5 text-right tabular-nums text-ink-secondary`}>{row.hindu.toLocaleString()}</td>
                      <td className={`${numericCell} border-b border-line py-2.5 text-right tabular-nums text-ink-secondary`}>{row.muslim.toLocaleString()}</td>
                      <td className={`${numericCell} border-b border-line py-2.5 text-right tabular-nums text-ink-secondary`}>{row.catholic.toLocaleString()}</td>
                      <td className={`${numericCell} border-b border-line py-2.5 text-right tabular-nums text-ink-secondary`}>{row.other.toLocaleString()}</td>
                      <td className={`${numericCell} border-b border-line py-2.5 text-right tabular-nums font-semibold text-ink`}>{row.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Gender by Part</h2>
            <p className="text-xs text-ink-tertiary">Male / female split per part.</p>
          </div>
          <PrintTableButton onClick={() => openPrint('genderPart')} disabled={genderPartMatrix.length === 0} />
        </div>
        <NumberTable
          columns={[
            { key: 'part', label: 'Part', render: (row) => <span className="font-medium text-ink">{row.part}</span> },
            { key: 'male', label: 'Male', className: 'text-right', cellClassName: 'text-right', render: (row) => row.male.toLocaleString() },
            { key: 'female', label: 'Female', className: 'text-right', cellClassName: 'text-right', render: (row) => row.female.toLocaleString() },
            { key: 'other', label: 'Other', className: 'text-right', cellClassName: 'text-right', render: (row) => row.other.toLocaleString() },
            { key: 'total', label: 'Total', className: 'text-right', cellClassName: 'text-right font-semibold text-ink', render: (row) => row.total.toLocaleString() },
          ]}
          rows={genderPartMatrix}
          emptyMessage="No part data for the current filter."
        />
      </section>

      <section className="rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Data Quality</h2>
            <p className="text-xs text-ink-tertiary">Missing and noteworthy records within the filtered scope.</p>
          </div>
          <PrintTableButton onClick={() => openPrint('dataQuality')} disabled={dataQualityRows.length === 0} />
        </div>
        <NumberTable
          columns={[
            { key: 'metric', label: 'Metric', render: (row) => <span className="font-medium text-ink">{row.label}</span> },
            { key: 'count', label: 'Count', className: 'text-right', cellClassName: 'text-right', render: (row) => row.count.toLocaleString() },
            { key: 'pct', label: '% of Scope', className: 'text-right', cellClassName: 'text-right', render: (row) => `${row.pct.toFixed(1)}%` },
          ]}
          rows={dataQualityRows}
        />
      </section>

      <section className="rounded-xl border border-line bg-white p-5 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Hierarchy</h2>
            <p className="text-xs text-ink-tertiary">Pick up to {MAX_LEVELS} grouping levels - the table drills down Part by Part, Section by Section.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={expandAll} className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">Expand All</button>
            <button type="button" onClick={collapseAll} className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted">Collapse All</button>
            <PrintTableButton onClick={() => openPrint('hierarchy')} disabled={tree.length === 0} />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
          {Array.from({ length: MAX_LEVELS }).map((_, index) => (
            <select
              key={index}
              className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              value={levels[index] ?? ''}
              aria-label={`Hierarchy level ${index + 1}`}
              onChange={(e) => setLevel(index, e.target.value as LevelKey | '')}
            >
              <option value="">Level {index + 1} - None</option>
              {LEVEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Voter &amp; Family Analysis</h2>
            <p className="text-xs text-ink-tertiary">
              {filteredFamilies.length.toLocaleString()} famil{filteredFamilies.length === 1 ? 'y' : 'ies'} · {totalAgg.voters.toLocaleString()} voters · Male {totalAgg.male} / Female {totalAgg.female}
            </p>
          </div>
          <PrintTableButton onClick={() => openPrint('hierarchy')} disabled={tree.length === 0} />
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading voters...
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-ink-tertiary">No voter data loaded. Adjust filters and click Reload Data.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead className="bg-[#f7f9fd]">
                <tr>
                  <th className={`border-b border-line px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary`}>Level</th>
                  <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Families</th>
                  <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Voters</th>
                  <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Male</th>
                  <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Female</th>
                  <th className={`border-b border-line ${numericCell} py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary`}>Avg Size</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-brand-50/40">
                  <td className="border-b border-line px-4 py-3 font-bold text-ink">Grand Total</td>
                  <td className={`${numericCell} border-b border-line py-3 text-right font-bold text-ink`}>{totalAgg.families}</td>
                  <td className={`${numericCell} border-b border-line py-3 text-right font-bold text-ink`}>{totalAgg.voters}</td>
                  <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{totalAgg.male}</td>
                  <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{totalAgg.female}</td>
                  <td className={`${numericCell} border-b border-line py-3 text-right text-ink-secondary`}>{totalAgg.avgSize.toFixed(1)}</td>
                </tr>
                {tree.map((node) => renderNode(node, true))}
                {tree.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-sm text-ink-tertiary">
                      No data matches the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ReportConfigModal
        title={printTarget ? PRINT_TARGET_TITLES[printTarget] : 'Insights'}
        open={printTarget !== null}
        mode="print"
        fontSize={printFontSize}
        boldText={printBold}
        printDescription="Set font size and bold text, then print or download a PDF of the current table."
        printActionLabel="Open print preview"
        onClose={() => setPrintTarget(null)}
        onConfirm={handlePrintConfirm}
        onDownloadPdf={handlePdfDownload}
      />
    </div>
  )
}
