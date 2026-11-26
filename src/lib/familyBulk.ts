import { compactLookupValue } from './searchUtils'
import type { FamilyGroup } from './searchUtils'

export type BulkEpicStatus = 'found' | 'notFound' | 'alreadyAssigned' | 'inAnotherFamily' | 'duplicate'

export interface ParsedEpicLine {
  raw: string
  epic: string
  duplicate: boolean
}

// Subset of Voter fields resolved by the bulk EPIC lookup. Enough to render
// the preview and to classify each row - full voter rows come from the page's
// own family lookup map when available.
export interface EpicLookupRow {
  id: string
  epic_no: string
  name: string
  family_head_epic: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
}

export interface BulkEpicLineResult {
  raw: string
  epic: string
  status: BulkEpicStatus
  voter: EpicLookupRow | null
  otherFamilyLabel: string | null
}

// Splits pasted text (one EPIC per line, e.g. straight from an Excel column)
// into normalized lookup values. Blank lines are dropped, a leading "EPIC"
// header cell is skipped, and every repeated value after its first occurrence
// is flagged as a duplicate so the preview can show it without extra lookups.
export function parseEpicList(text: string): ParsedEpicLine[] {
  const seen = new Set<string>()
  const lines: ParsedEpicLine[] = []
  let firstDataLineSeen = false

  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim()
    if (!raw) continue

    const value = raw.toUpperCase()
    if (!firstDataLineSeen && /^EPIC/.test(value) && !/\d/.test(value)) {
      firstDataLineSeen = true
      continue
    }
    firstDataLineSeen = true

    const epic = compactLookupValue(raw)
    if (!epic) continue

    if (seen.has(epic)) {
      lines.push({ raw, epic, duplicate: true })
    } else {
      seen.add(epic)
      lines.push({ raw, epic, duplicate: false })
    }
  }

  return lines
}

function classifyVoter(
  line: ParsedEpicLine,
  voter: EpicLookupRow,
  targetHeadEpic: string,
  familyLookupByEpic: Map<string, FamilyGroup>,
  otherHeadNameByEpic: Map<string, string>,
): BulkEpicLineResult {
  const ownEpic = compactLookupValue(voter.epic_no)
  const linkedHead = compactLookupValue(voter.family_head_epic)

  // The family head itself, or a voter whose family_head_epic already points
  // at this family, is already assigned here.
  if (ownEpic === targetHeadEpic || linkedHead === targetHeadEpic) {
    return { raw: line.raw, epic: line.epic, status: 'alreadyAssigned', voter, otherFamilyLabel: null }
  }

  // A voter who is a member (or head) of a family with other members is owned
  // by that family - reuse the single-add rule: remove them from their current
  // family before assigning them here.
  const theirFamily = familyLookupByEpic.get(ownEpic)
  if (theirFamily && theirFamily.members.length > 1) {
    return {
      raw: line.raw,
      epic: line.epic,
      status: 'inAnotherFamily',
      voter,
      otherFamilyLabel: theirFamily.headVoter?.name ?? theirFamily.head,
    }
  }

  // Voter is not in the page's loaded rows (out of ward scope) but their
  // family_head_epic points at another head - still a member of another
  // family. The head name may be resolved from a supplementary lookup; fall
  // back to the head EPIC itself.
  if (linkedHead && linkedHead !== ownEpic) {
    return {
      raw: line.raw,
      epic: line.epic,
      status: 'inAnotherFamily',
      voter,
      otherFamilyLabel: otherHeadNameByEpic.get(linkedHead) ?? linkedHead,
    }
  }

  // Solo voter (family_head_epic null or self-referencing) - eligible.
  return { raw: line.raw, epic: line.epic, status: 'found', voter, otherFamilyLabel: null }
}

export function classifyEpicLines(input: {
  lines: ParsedEpicLine[]
  foundByEpic: Map<string, EpicLookupRow>
  targetHeadEpic: string
  familyLookupByEpic: Map<string, FamilyGroup>
  otherHeadNameByEpic: Map<string, string>
}): BulkEpicLineResult[] {
  const { lines, foundByEpic, targetHeadEpic, familyLookupByEpic, otherHeadNameByEpic } = input

  return lines.map((line) => {
    if (line.duplicate) {
      return { raw: line.raw, epic: line.epic, status: 'duplicate', voter: null, otherFamilyLabel: null }
    }

    const voter = foundByEpic.get(line.epic) ?? null
    if (!voter) {
      return { raw: line.raw, epic: line.epic, status: 'notFound', voter: null, otherFamilyLabel: null }
    }

    return classifyVoter(line, voter, targetHeadEpic, familyLookupByEpic, otherHeadNameByEpic)
  })
}

// Head EPICs of "in another family" voters that the page's family lookup map
// cannot resolve (the voter/family sits outside the loaded ward scope). The
// caller batches one extra query for these so the preview can name the family
// the voter currently belongs to.
export function collectUnresolvedOtherHeadEpics(
  lines: ParsedEpicLine[],
  foundByEpic: Map<string, EpicLookupRow>,
  targetHeadEpic: string,
  familyLookupByEpic: Map<string, FamilyGroup>,
): string[] {
  const epics = new Set<string>()

  for (const line of lines) {
    if (line.duplicate) continue
    const voter = foundByEpic.get(line.epic)
    if (!voter) continue

    const ownEpic = compactLookupValue(voter.epic_no)
    const linkedHead = compactLookupValue(voter.family_head_epic)
    if (ownEpic === targetHeadEpic || linkedHead === targetHeadEpic) continue
    if (familyLookupByEpic.get(ownEpic)) continue
    if (linkedHead && linkedHead !== ownEpic) epics.add(linkedHead)
  }

  return Array.from(epics)
}
