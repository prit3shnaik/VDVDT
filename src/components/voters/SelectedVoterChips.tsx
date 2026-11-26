import { X } from 'lucide-react'
import type { Voter } from '../../lib/types'
import { initials } from '../../lib/searchUtils'

export interface SelectedVoterChipsProps {
  voters: Voter[]
  photoUrlByPath: Record<string, string>
  onRemove: (id: string) => void
}

export function SelectedVoterChips({ voters, photoUrlByPath, onRemove }: SelectedVoterChipsProps) {
  if (voters.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-6 text-center text-xs text-slate-500">
        No members selected yet. Use the search above to add voters.
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {voters.map((v) => {
        const photo = v.photo_url ? photoUrlByPath[v.photo_url] : undefined
        return (
          <div
            key={v.id}
            className="group flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-2 text-xs shadow-sm transition hover:border-slate-300"
          >
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-brand-50">
              {photo ? (
                <img src={photo} alt={v.name} className="h-full w-full object-cover" />
              ) : (
                <span className="text-[9px] font-semibold text-brand-700">{initials(v.name)}</span>
              )}
            </div>
            <span className="max-w-[140px] truncate font-medium text-slate-800">{v.name}</span>
            <span className="hidden text-slate-400 sm:inline">{v.epic_no}</span>
            <button
              type="button"
              onClick={() => onRemove(v.id)}
              className="rounded-full p-0.5 text-slate-400 transition hover:bg-rose-100 hover:text-rose-600"
              aria-label={`Remove ${v.name}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
