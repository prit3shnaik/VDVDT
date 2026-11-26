import { type ReactNode } from 'react'
import type { Voter } from './types'

export function normalizeLookupValue(value: string | number | null | undefined): string {
  return (value ?? '').toString().toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function compactLookupValue(value: string | number | null | undefined): string {
  return normalizeLookupValue(value).replace(/\s+/g, '')
}

export function tokenizeLookup(value: string): string[] {
  return normalizeLookupValue(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
}

export function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

export function isLikelyEpicToken(value: string): boolean {
  const compact = compactLookupValue(value)
  return compact.length >= 6 && /[0-9]/.test(compact) && /^[A-Z0-9]+$/.test(compact)
}

export function matchesLookupTokens(lookupText: string, tokens: string[]): boolean {
  if (!tokens.length) {
    return true
  }

  const compactLookup = lookupText.replace(/\s+/g, '')
  return tokens.every((token) => {
    const compactToken = token.replace(/\s+/g, '')
    return lookupText.includes(token) || compactLookup.includes(compactToken)
  })
}

export function normalizeGroupingValue(value: string | number | null | undefined): string {
  return (value ?? '').toString().trim().toUpperCase()
}

export interface FamilyGroup {
  key: string
  head: string
  headVoter: Voter | null
  members: Voter[]
}

export function buildFamilies(rows: Voter[]): FamilyGroup[] {
  const groups = new Map<string, Voter[]>()
  for (const row of rows) {
    const linkedHead = normalizeGroupingValue(row.family_head_epic)
    const key = linkedHead || normalizeGroupingValue(row.epic_no)
    const members = groups.get(key)
    if (members) members.push(row)
    else groups.set(key, [row])
  }

  const families: FamilyGroup[] = Array.from(groups.entries()).map(([headEpic, members]) => {
    const sortedMembers = [...members].sort((a, b) => {
      const aIsHead = normalizeGroupingValue(a.epic_no) === headEpic
      const bIsHead = normalizeGroupingValue(b.epic_no) === headEpic
      if (aIsHead && !bIsHead) return -1
      if (!aIsHead && bIsHead) return 1
      if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order
      if (a.display_order != null) return -1
      if (b.display_order != null) return 1
      return a.name.localeCompare(b.name)
    })
    const headVoter = sortedMembers.find((member) => normalizeGroupingValue(member.epic_no) === headEpic) ?? sortedMembers[0] ?? null
    return { key: `GROUP|${headEpic}`, head: headEpic, headVoter, members: sortedMembers }
  })

  families.sort((a, b) => (a.headVoter?.name ?? a.head).localeCompare(b.headVoter?.name ?? b.head))
  return families
}

export function buildFamilyLookupText(family: FamilyGroup): string {
  return normalizeLookupValue(
    [
      family.head,
      family.headVoter?.name ?? '',
      family.headVoter?.epic_no ?? '',
      family.headVoter?.part_no ?? '',
      family.headVoter?.ward_no ?? '',
      family.headVoter?.section ?? '',
      ...family.members.flatMap((member) => [
        member.name,
        member.epic_no,
        member.relative_name ?? '',
        member.relative_relation ?? '',
        member.contact_no_1 ?? '',
        member.contact_no_2 ?? '',
        member.house_no ?? '',
        member.part_no ?? '',
        member.ward_no ?? '',
        member.section ?? '',
      ]),
    ].join(' '),
  )
}

export function familyContainsEpic(family: FamilyGroup, epic: string): boolean {
  const target = compactLookupValue(epic)
  if (!target) return false
  return family.members.some((member) => {
    return (
      compactLookupValue(member.epic_no) === target ||
      compactLookupValue(member.family_head_epic) === target ||
      compactLookupValue(family.head) === target
    )
  })
}

export function familyMatchesSearch(family: FamilyGroup, tokens: string[]): boolean {
  if (!tokens.length) return false
  if (tokens.length === 1 && isLikelyEpicToken(tokens[0])) {
    return familyContainsEpic(family, tokens[0])
  }
  if (matchesLookupTokens(buildFamilyLookupText(family), tokens)) return true
  return tokens.length === 1 && familyContainsEpic(family, tokens[0])
}

export function memberMatchesSearch(member: Voter, tokens: string[]): boolean {
  return tokens.length > 0 && matchesLookupTokens(buildVoterLookupText(member), tokens)
}

export function buildVoterLookupText(voter: Voter): string {
  return normalizeLookupValue(
    [
      voter.name,
      voter.epic_no,
      voter.relative_name,
      voter.relative_relation,
      voter.house_no,
      voter.contact_no_1,
      voter.contact_no_2,
      voter.section_name,
      voter.family_head_epic,
      voter.family_label,
    ]
      .filter(Boolean)
      .join(' '),
  )
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function formatCandidateLabel(voter: Voter): string {
  const location = [voter.ward_no ? `Ward ${voter.ward_no}` : null, voter.part_no ? `Part ${voter.part_no}` : null]
    .filter(Boolean)
    .join(' - ')

  return location ? `${voter.name} (${voter.epic_no}) - ${location}` : `${voter.name} (${voter.epic_no})`
}

export function highlightMatch(text: string, tokens: string[]): ReactNode[] {
  if (!tokens.length || !text) {
    return [text]
  }

  const spans: React.ReactNode[] = []
  let remaining = text

  for (const token of tokens) {
    const compactToken = token.replace(/\s+/g, '')
    const upperRemaining = remaining.toUpperCase()
    const compactRemaining = upperRemaining.replace(/\s+/g, '')

    let matchIndex = upperRemaining.indexOf(token)
    let matchLength = token.length

    if (matchIndex === -1) {
      matchIndex = compactRemaining.indexOf(compactToken)
      if (matchIndex !== -1) {
        let charCount = 0
        let adjustedIndex = 0
        for (let i = 0; i < upperRemaining.length; i++) {
          if (upperRemaining[i] !== ' ') {
            if (charCount === matchIndex) {
              adjustedIndex = i
              break
            }
            charCount++
          }
        }
        matchIndex = adjustedIndex

        matchLength = 0
        let compactPos = 0
        for (let i = adjustedIndex; i < upperRemaining.length; i++) {
          if (upperRemaining[i] !== ' ') {
            if (compactPos >= compactToken.length) break
            compactPos++
            matchLength = i - adjustedIndex + 1
          } else {
            matchLength = i - adjustedIndex + 1
          }
        }
        if (compactPos < compactToken.length) matchLength = upperRemaining.length - adjustedIndex
      }
    }

    if (matchIndex === -1) continue

    const before = remaining.slice(0, matchIndex)
    const match = remaining.slice(matchIndex, matchIndex + matchLength)
    remaining = remaining.slice(matchIndex + matchLength)

    if (before) spans.push(before)
    spans.push(
      <mark key={`hl-${spans.length}`} className="rounded bg-amber-200 px-0.5 text-inherit">
        {match}
      </mark>,
    )
  }

  if (remaining) spans.push(remaining)

  return spans.length > 0 ? spans : [text]
}
