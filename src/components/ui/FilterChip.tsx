import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

interface FilterChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  onDismiss?: () => void
  children: ReactNode
}

export function FilterChip({ active = false, onDismiss, className, children, ...props }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onDismiss ?? props.onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition',
        onDismiss || active
          ? 'border border-brand-200 bg-brand-50 text-brand-700'
          : 'border border-line bg-white text-ink-secondary hover:border-line-strong hover:bg-muted',
        className,
      )}
      {...props}
    >
      {children}
      {onDismiss ? <X className="h-3.5 w-3.5" /> : null}
    </button>
  )
}
