import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, className, children, id, ...props },
  ref,
) {
  return (
    <label className="block text-sm font-medium text-ink-secondary">
      {label ? <span className="mb-1.5 block">{label}</span> : null}
      <select
        ref={ref}
        id={id}
        className={cn(
            'h-10 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    </label>
  )
})
