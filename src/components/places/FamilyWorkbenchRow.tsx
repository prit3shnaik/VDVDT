import { presenceLabel, presenceNoteOf } from '../../lib/presence'
import type { PresenceStatus } from '../../lib/types'
import type { SlimFamily } from '../../lib/placeWorkbench'

export function FamilyWorkbenchRow({
  family,
  checked,
  onToggle,
  selectable,
  placeLabel,
  leaderName,
  expanded,
  onExpand,
}: {
  family: SlimFamily
  checked?: boolean
  onToggle?: () => void
  selectable?: boolean
  placeLabel?: string
  leaderName?: string
  expanded?: boolean
  onExpand?: () => void
}) {
  const head = family.headVoter ?? family.members[0]
  const status = (head?.presence_status ?? null) as PresenceStatus | null
  const note = presenceNoteOf(head)
  const hasDetail = Boolean(note)

  return (
    <div className="flex items-start gap-3 px-5 py-3 hover:bg-muted">
      {selectable ? (
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-line text-brand-600"
          checked={Boolean(checked)}
          onChange={onToggle}
        />
      ) : null}
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onExpand}>
        <p className="truncate text-sm font-semibold text-ink">{head?.name ?? family.head}</p>
        <p className="text-xs text-ink-tertiary">
          EPIC {head?.epic_no ?? family.head}
          {' · '}Part {head?.part_no ?? '-'}
          {' · '}{family.members.length} member{family.members.length === 1 ? '' : 's'}
          {leaderName ? ` · ${leaderName}` : ''}
          {placeLabel ? ` · ${placeLabel}` : ''}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span
            className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700"
            title={hasDetail ? `${presenceLabel(status) ?? 'Presence'} — ${note}` : (presenceLabel(status) ?? 'Not set')}
          >
            {presenceLabel(status) ?? 'Not set'}
          </span>
          {hasDetail && !expanded ? (
            <span className="line-clamp-2 max-w-[36rem] whitespace-pre-wrap text-xs text-ink-tertiary" title={note}>{note}</span>
          ) : null}
        </div>
        {expanded && hasDetail ? (
          <div className="mt-2 space-y-1 text-xs text-ink-secondary">
            {note ? <p className="whitespace-pre-wrap"><span className="font-semibold text-ink-tertiary">Note:</span> {note}</p> : null}
          </div>
        ) : null}
      </button>
    </div>
  )
}
