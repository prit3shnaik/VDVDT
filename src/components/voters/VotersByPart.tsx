import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Phone } from 'lucide-react'
import type { Voter } from '../../lib/types'

interface VotersByPartProps {
  voters: Voter[]
  onSelectVoter: (voter: Voter) => void
}

interface PartGroup {
  partKey: string
  partLabel: string
  sortValue: number
  voters: Voter[]
}

function groupVotersByPart(voters: Voter[]): PartGroup[] {
  const map = new Map<string, PartGroup>()

  for (const voter of voters) {
    const partKey = voter.part_no == null ? '' : String(voter.part_no)
    const existing = map.get(partKey)
    if (existing) {
      existing.voters.push(voter)
    } else {
      map.set(partKey, {
        partKey,
        partLabel: voter.part_no == null ? 'Unassigned' : `Part ${voter.part_no}`,
        sortValue: voter.part_no ?? Number.POSITIVE_INFINITY,
        voters: [voter],
      })
    }
  }

  return Array.from(map.values()).sort((a, b) => a.sortValue - b.sortValue)
}

export function VotersByPart({ voters, onSelectVoter }: VotersByPartProps) {
  const groups = useMemo(() => groupVotersByPart(voters), [voters])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  if (!groups.length) {
    return (
      <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-ink-secondary">
        No voters to show.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const isCollapsed = Boolean(collapsed[group.partKey])
        return (
          <section key={group.partKey || 'unassigned'} className="overflow-hidden rounded-xl border border-line bg-white shadow-soft">
            <button
              type="button"
              onClick={() =>
                setCollapsed((current) => ({
                  ...current,
                  [group.partKey]: !current[group.partKey],
                }))
              }
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-muted"
              aria-expanded={!isCollapsed}
            >
              <span className="flex min-w-0 items-center gap-2">
                {isCollapsed ? <ChevronRight className="h-4 w-4 text-ink-tertiary" /> : <ChevronDown className="h-4 w-4 text-ink-tertiary" />}
                <span className="truncate font-semibold text-ink">{group.partLabel}</span>
              </span>
              <span className="shrink-0 rounded-full border border-line bg-muted px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                {group.voters.length} voter{group.voters.length === 1 ? '' : 's'}
              </span>
            </button>

            {isCollapsed ? null : (
              <ul className="divide-y divide-line border-t border-line">
                {group.voters.map((voter) => {
                  const contact = voter.contact_no_1 ?? voter.contact_no_2
                  return (
                    <li key={voter.id}>
                      <div
                        className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-muted"
                        onClick={() => onSelectVoter(voter)}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 truncate font-medium text-ink">
                            <span className="truncate">{voter.name}</span>
                          </p>
                          <p className="truncate text-xs text-ink-tertiary">
                            EPIC {voter.epic_no}
                            {voter.sr_no_roll != null ? ` · Sr ${voter.sr_no_roll}` : ''}
                            {voter.section != null ? ` · Section ${voter.section}` : ''}
                            {voter.age != null ? ` · ${voter.age} yrs` : ''}
                            {voter.gender ? ` · ${voter.gender}` : ''}
                          </p>
                        </div>
                        {contact ? (
                          <a
                            href={`tel:${contact}`}
                            onClick={(event) => event.stopPropagation()}
                            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-ink-secondary hover:bg-muted"
                          >
                            <Phone className="h-3.5 w-3.5" />
                            Call
                          </a>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
