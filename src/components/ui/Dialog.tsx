import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface DialogProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  labelledBy?: string
}

export function Dialog({ open, onClose, children, className, labelledBy }: DialogProps) {
  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40"
        onClick={onClose}
        aria-label="Close dialog"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn(
          'relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-line bg-white shadow-popover',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
