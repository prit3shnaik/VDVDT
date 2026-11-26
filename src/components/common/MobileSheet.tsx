import type { ReactNode } from 'react'
import { X } from 'lucide-react'

interface MobileSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  footer?: ReactNode
  breakpoint?: 'md' | 'lg'
  maxHeightClassName?: string
  contentClassName?: string
}

export function MobileSheet({
  open,
  onClose,
  title,
  children,
  footer,
  breakpoint = 'md',
  maxHeightClassName = 'max-h-[88vh]',
  contentClassName = 'overflow-y-auto',
}: MobileSheetProps) {
  if (!open) {
    return null
  }

  return (
    <div className={`fixed inset-0 z-50 ${breakpoint === 'lg' ? 'lg:hidden' : 'md:hidden'}`}>
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40"
        onClick={onClose}
        aria-label="Close panel"
      />
      <div className={`absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t border-line bg-white ${maxHeightClassName}`}>
        <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-line-strong" />
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          {title ? <p className="text-lg font-semibold text-ink">{title}</p> : <span />}
          <button
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-tertiary active:bg-muted"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className={`min-h-0 flex-1 px-4 pb-4 ${contentClassName}`}>{children}</div>
        {footer ? (
          <div className="shrink-0 border-t border-line p-4 pb-6">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
