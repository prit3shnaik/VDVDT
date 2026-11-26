import type { PresenceStatus, Voter } from './types'

export const PRESENCE_OPTIONS: Array<{ value: PresenceStatus; label: string }> = [
  { value: 'IN_MORMUGAO', label: 'In Mormugao' },
  { value: 'OUTSIDE_MORMUGAO', label: 'Outside Mormugao' },
  { value: 'ABROAD', label: 'Abroad' },
]

export function presenceLabel(status: PresenceStatus | null | undefined): string | null {
  if (!status) return null
  return PRESENCE_OPTIONS.find((option) => option.value === status)?.label ?? status
}

export function effectivePresence(voter: Pick<Voter, 'presence_status'> | null | undefined): PresenceStatus | null {
  return voter?.presence_status ?? null
}

export function familyPresence(
  members: Array<Pick<Voter, 'presence_status'>>,
  head: Pick<Voter, 'presence_status'> | null | undefined,
): PresenceStatus | null {
  return effectivePresence(head ?? members[0] ?? null)
}

export function hasPresenceOverride(member: Pick<Voter, 'presence_status'>, head: Pick<Voter, 'presence_status'> | null | undefined): boolean {
  if (!member.presence_status) return false
  return member.presence_status !== (head?.presence_status ?? null)
}

export function presenceNoteOf(voter: Pick<Voter, 'presence_note'> | null | undefined): string {
  return (voter?.presence_note || '').trim()
}

export function presenceTabLabel(
  status: PresenceStatus | null | undefined,
  note?: string | null,
): string {
  const label = presenceLabel(status)
  const trimmed = (note ?? '').trim()
  if (label && trimmed) return `${label} — ${trimmed}`
  if (label) return label
  if (trimmed) return trimmed
  return 'Presence'
}

export function presenceDisplay(voter: Pick<Voter, 'presence_status' | 'presence_note'> | null | undefined): string {
  if (!voter) return ''
  return presenceTabLabel(voter.presence_status, presenceNoteOf(voter))
}

export const PRESENCE_NOTE_MAX_LENGTH = 1000
export const IN_MORMUGAO_NOTE_HELP = 'House, area, landmark — e.g. 2nd floor, near chapel'

export function presenceNotePlaceholder(status: PresenceStatus | null | undefined): string {
  if (status === 'ABROAD') return 'Country / city'
  if (status === 'OUTSIDE_MORMUGAO') return 'Place + return note'
  if (status === 'IN_MORMUGAO') return 'Area / house / landmark'
  return 'Where they stay'
}

export function distinctSortedValues(rows: Array<string | null | undefined>): string[] {
  const set = new Set<string>()
  for (const row of rows) {
    const value = (row ?? '').trim()
    if (value) set.add(value)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}
