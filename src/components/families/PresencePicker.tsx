import { useEffect, useId, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import type { PresenceStatus } from '../../lib/types'
import {
  IN_MORMUGAO_NOTE_HELP,
  PRESENCE_NOTE_MAX_LENGTH,
  PRESENCE_OPTIONS,
  presenceLabel,
  presenceNotePlaceholder,
} from '../../lib/presence'
import { FloatingDropdown } from '../common/FloatingDropdown'
import { MobileSheet } from '../common/MobileSheet'
import { useIsMobile } from '../../hooks/useIsMobile'

export function PresencePicker({
  status,
  note,
  heading = 'Classify presence',
  disabled = false,
  saving = false,
  compact = false,
  showPrefix = true,
  showCompactNote = true,
  areaSuggestions = [],
  open,
  anchor,
  onToggle,
  onClose,
  onSave,
  onClear,
}: {
  status: PresenceStatus | null
  note: string
  heading?: string
  disabled?: boolean
  saving?: boolean
  compact?: boolean
  showPrefix?: boolean
  showCompactNote?: boolean
  areaSuggestions?: string[]
  open: boolean
  anchor: HTMLButtonElement | null
  onToggle: (button: HTMLButtonElement) => void
  onClose: () => void
  onSave: (status: PresenceStatus, note: string) => void
  onClear: () => void
}) {
  const isMobile = useIsMobile()
  const noteId = useId()
  const [draftStatus, setDraftStatus] = useState<PresenceStatus | null>(status)
  const [draftNote, setDraftNote] = useState(note)

  useEffect(() => {
    if (open) {
      setDraftStatus(status)
      setDraftNote(note)
    }
  }, [open, status, note])

  const statusLabel = presenceLabel(status) ?? 'Presence'
  const trimmedNote = note.trim()
  const triggerTitle = trimmedNote ? `${statusLabel} — ${trimmedNote}` : statusLabel
  const draftDirty = draftStatus !== status || draftNote.trim() !== note.trim()
  const canSave = !!draftStatus && draftDirty

  const closeWithoutSaving = () => {
    setDraftStatus(status)
    setDraftNote(note)
    onClose()
  }

  const saveDraft = () => {
    if (!draftStatus) return
    onSave(draftStatus, draftNote)
    onClose()
  }

  const panel = (
    <div className="space-y-2">
      {isMobile ? null : (
        <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
          {heading}
        </p>
      )}
      <div className="grid gap-1">
        {PRESENCE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitem"
            className={`block w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-muted ${
              draftStatus === option.value ? 'bg-muted font-semibold text-ink' : 'text-ink-secondary'
            }`}
            onClick={() => setDraftStatus(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {status ? (
        <button
          type="button"
          role="menuitem"
          className="block w-full rounded-xl px-3 py-2 text-left text-sm text-ink-tertiary transition hover:bg-muted"
          onClick={() => {
            onClear()
            onClose()
          }}
        >
          Clear presence
        </button>
      ) : null}
      {draftStatus ? (
        <div className="space-y-1.5 border-t border-line pt-2">
          <label htmlFor={noteId} className="block px-1 text-xs font-semibold text-ink-secondary">
            Address / location
          </label>
          <textarea
            id={noteId}
            rows={4}
            maxLength={PRESENCE_NOTE_MAX_LENGTH}
            className="min-h-[6.5rem] w-full resize-y rounded-xl border border-line px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            placeholder={presenceNotePlaceholder(draftStatus)}
            value={draftNote}
            onChange={(event) => setDraftNote(event.target.value)}
            onClick={(event) => event.stopPropagation()}
          />
          {draftStatus === 'IN_MORMUGAO' ? (
            <p className="px-1 text-[11px] text-ink-tertiary">{IN_MORMUGAO_NOTE_HELP}</p>
          ) : null}
          {draftStatus === 'IN_MORMUGAO' && areaSuggestions.length ? (
            <div className="flex flex-wrap gap-1 px-1">
              {areaSuggestions.slice(0, 6).map((area) => (
                <button
                  key={area}
                  type="button"
                  className="rounded-full border border-line bg-white px-2 py-0.5 text-[11px] font-medium text-ink-secondary transition hover:bg-muted"
                  onClick={() => setDraftNote((current) => (current.trim() ? `${area} — ${current}` : area))}
                >
                  {area}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-between px-1 text-[10px] text-ink-tertiary">
            <span>Optional</span>
            <span>{draftNote.length}/{PRESENCE_NOTE_MAX_LENGTH}</span>
          </div>
          <button
            type="button"
            disabled={!canSave || saving}
            className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-brand-600 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={saveDraft}
          >
            Save
          </button>
        </div>
      ) : null}
    </div>
  )

  return (
    <div className={compact ? 'flex min-w-0 max-w-full flex-col gap-0.5' : 'relative'}>
      <div className="relative min-w-0">
        <button
          type="button"
          disabled={disabled || saving}
          title={triggerTitle}
          aria-label={showPrefix ? `Presence: ${statusLabel}` : statusLabel}
          className={
            compact
              ? 'inline-flex h-9 max-w-full items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-medium text-ink-secondary transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-50'
              : 'inline-flex h-10 max-w-[14rem] items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-secondary shadow-sm transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-50'
          }
          onClick={(event) => {
            event.stopPropagation()
            onToggle(event.currentTarget)
          }}
        >
          {saving ? <Loader2 className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} animate-spin`} /> : null}
          {showPrefix ? <span className="shrink-0 text-ink-tertiary">Presence:</span> : null}
          <span className="min-w-0 truncate text-left">{statusLabel}</span>
          <ChevronDown className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} shrink-0 text-ink-tertiary transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {isMobile ? (
          <MobileSheet
            open={open}
            onClose={closeWithoutSaving}
            title={heading}
            maxHeightClassName="max-h-[92vh]"
          >
            {panel}
          </MobileSheet>
        ) : (
          <FloatingDropdown
            open={open}
            onClose={closeWithoutSaving}
            anchor={open ? anchor : null}
            className="max-h-[calc(100vh-2rem)] w-[26rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-line bg-white p-3"
          >
            {panel}
          </FloatingDropdown>
        )}
      </div>
      {compact && showCompactNote && trimmedNote ? (
        <span className="mt-0.5 line-clamp-2 min-w-0 whitespace-pre-wrap text-xs text-ink-tertiary" title={trimmedNote}>
          {trimmedNote}
        </span>
      ) : null}
    </div>
  )
}
