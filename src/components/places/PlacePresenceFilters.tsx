import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { PlaceClub } from '../../lib/types'
import { isOutsidePlaceClub, placeClubFullLabel, placeClubLabel, type PlaceScope } from '../../lib/placeClubs'
import {
  PLACE_SCOPE_CHIPS,
  PRESENCE_FILTER_CHIPS,
  type LeaderFilter,
  type NotesFilter,
  type PresenceFilter,
} from '../../lib/placePresenceFilters'

export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center rounded-full px-3 text-xs font-semibold transition',
        active ? 'border border-brand-100 bg-brand-50 text-brand-700' : 'border border-line bg-white text-ink-secondary hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

export function PresenceFilterChips({
  value,
  onChange,
}: {
  value: PresenceFilter
  onChange: (value: PresenceFilter) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PRESENCE_FILTER_CHIPS.map((chip) => (
        <FilterChip key={chip.value} active={value === chip.value} onClick={() => onChange(chip.value)}>
          {chip.label}
        </FilterChip>
      ))}
    </div>
  )
}

export function PlaceScopeChips({
  value,
  onChange,
}: {
  value: PlaceScope
  onChange: (value: PlaceScope) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PLACE_SCOPE_CHIPS.map((chip) => (
        <FilterChip key={chip.value} active={value === chip.value} onClick={() => onChange(chip.value)}>
          {chip.label}
        </FilterChip>
      ))}
    </div>
  )
}

export function PlacePresenceFilterBar({
  presence,
  onPresence,
  place,
  onPlace,
  clubs,
  part,
  onPart,
  parts,
  leader,
  onLeader,
  leaders,
  query,
  onQuery,
  notes,
  onNotes,
  searchPlaceholder = 'Search name, EPIC, note',
  showNotesChip = false,
  extra,
  showPlace = true,
  plain = false,
}: {
  presence: PresenceFilter
  onPresence: (value: PresenceFilter) => void
  place: string
  onPlace: (value: string) => void
  clubs: PlaceClub[]
  part: string
  onPart: (value: string) => void
  parts: string[]
  leader: LeaderFilter
  onLeader: (value: LeaderFilter) => void
  leaders: Array<{ id: string; name: string }>
  query: string
  onQuery: (value: string) => void
  notes?: NotesFilter
  onNotes?: (value: NotesFilter) => void
  searchPlaceholder?: string
  showNotesChip?: boolean
  showPlace?: boolean
  plain?: boolean
  extra?: ReactNode
}) {
  const outsideClubs = clubs.filter((club) => isOutsidePlaceClub(club))
  const localClubs = clubs.filter((club) => !isOutsidePlaceClub(club))

  return (
    <section className={plain ? 'flex flex-wrap items-center gap-2' : 'flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-4'}>
      <PresenceFilterChips value={presence} onChange={onPresence} />
      {showPlace ? (
        <select
          className="h-8 rounded-full border border-line bg-white px-3 text-xs font-semibold text-ink-secondary outline-none"
          value={place}
          onChange={(event) => onPlace(event.target.value)}
        >
          <option value="all">All places</option>
          <option value="unlabelled">Unlabelled</option>
          {outsideClubs.length ? (
            <optgroup label="Outside Mormugao">
              {outsideClubs.map((club) => (
                <option key={club.id} value={club.id}>{placeClubFullLabel(club)}</option>
              ))}
            </optgroup>
          ) : null}
          {localClubs.length ? (
            <optgroup label="Local">
              {localClubs.map((club) => (
                <option key={club.id} value={club.id}>{placeClubLabel(club)}</option>
              ))}
            </optgroup>
          ) : null}
        </select>
      ) : null}
      <select
        className="h-8 rounded-full border border-line bg-white px-3 text-xs font-semibold text-ink-secondary outline-none"
        value={part}
        onChange={(event) => onPart(event.target.value)}
      >
        <option value="">All parts</option>
        {parts.map((value) => (
          <option key={value} value={value}>Part {value}</option>
        ))}
      </select>
      <select
        className="h-8 min-w-[10rem] rounded-full border border-line bg-white px-3 text-xs font-semibold text-ink-secondary outline-none"
        value={leader}
        onChange={(event) => onLeader(event.target.value)}
      >
        <option value="all">All leaders</option>
        <option value="unassigned">Unassigned</option>
        {leaders.map((row) => (
          <option key={row.id} value={row.id}>{row.name}</option>
        ))}
      </select>
      <div className="relative min-w-[14rem] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
        <input
          className="h-8 w-full rounded-full border border-line bg-white pl-8 pr-3 text-xs outline-none focus:border-brand-300"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      {showNotesChip && onNotes ? (
        <FilterChip active={notes === 'yes'} onClick={() => onNotes(notes === 'yes' ? 'all' : 'yes')}>
          Has note
        </FilterChip>
      ) : null}
      {extra}
    </section>
  )
}
