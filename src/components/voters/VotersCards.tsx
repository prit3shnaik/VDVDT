import { ChevronRight, Phone } from 'lucide-react'
import type { Voter } from '../../lib/types'
import { voterCategoryLabel } from '../../lib/voterCategory'

interface VotersCardsProps {
  voters: Voter[]
  photoUrls: Record<string, string>
  onSelectVoter: (voter: Voter) => void
}

export function VotersCards({ voters, photoUrls, onSelectVoter }: VotersCardsProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {voters.map((voter) => {
        const categoryLabel = voterCategoryLabel(voter.voter_category)
        const contact = voter.contact_no_1 ?? voter.contact_no_2
        const relativeText = voter.relative_name
          ? `${voter.relative_name}${voter.relative_relation ? ` (${voter.relative_relation})` : ''}`
          : null
        return (
          <article
            key={voter.id}
            className="cursor-pointer rounded-xl border border-line bg-white p-4 shadow-soft transition hover:border-line-strong hover:shadow-lift active:bg-muted"
            onClick={() => onSelectVoter(voter)}
          >
            <div className="flex items-start gap-3">
              {photoUrls[voter.id] ? (
                <img
                  src={photoUrls[voter.id]}
                  alt={voter.name}
                  loading="lazy"
                  decoding="async"
                  className="h-10 w-10 shrink-0 rounded-lg border border-line object-cover"
                />
              ) : (
                <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-sm font-bold text-brand-700">
                  {voter.name
                    .split(' ')
                    .map((part) => part.charAt(0))
                    .slice(0, 2)
                    .join('')
                    .toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{voter.name}</p>
                <p className="truncate text-sm text-ink-secondary">EPIC: {voter.epic_no}</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="inline-flex rounded-full border border-line bg-muted px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                Part {voter.part_no ?? '-'}
              </span>
              <span className="inline-flex rounded-full border border-line bg-muted px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                Section {voter.section ?? '-'}
              </span>
              <span className="inline-flex rounded-full border border-line bg-muted px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                Sr no {voter.sr_no_roll ?? '-'}
              </span>
              {categoryLabel ? (
                <span className="inline-flex rounded-full border border-line bg-muted px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                  {categoryLabel}
                </span>
              ) : null}
            </div>

            <div className="mt-3 space-y-1 text-sm text-ink-secondary">
              {voter.house_no ? (
                <p className="truncate">House: {voter.house_no}</p>
              ) : null}
              {relativeText ? <p className="truncate">{relativeText}</p> : null}
              <p>
                {voter.age ? `${voter.age} yrs` : 'Age -'} · {voter.gender ?? '-'}
              </p>
            </div>

            <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
              <a
                href={contact ? `tel:${contact}` : '#'}
                onClick={(event) => event.stopPropagation()}
                className={`inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium ${
                  contact ? 'text-ink-secondary hover:bg-muted' : 'pointer-events-none text-ink-tertiary'
                }`}
              >
                <Phone className="h-4 w-4" />
                Call
              </a>
              <span className="inline-flex h-10 items-center gap-1 px-3 text-sm font-medium text-ink-secondary">
                Details
                <ChevronRight className="h-4 w-4" />
              </span>
            </div>
          </article>
        )
      })}
    </div>
  )
}
