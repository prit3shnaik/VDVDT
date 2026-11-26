import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  trailing?: ReactNode
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, trailing, className, id, ...props },
  ref,
) {
  return (
    <label className="block text-sm font-medium text-ink-secondary">
      {label ? <span className="mb-1.5 block">{label}</span> : null}
      <span className="relative block">
        <input
          ref={ref}
          id={id}
          className={cn(
            'h-10 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink outline-none transition placeholder:text-ink-tertiary focus:border-brand-500 focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-tertiary',
            trailing && 'pr-10',
            className,
          )}
          {...props}
        />
        {trailing ? (
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-ink-tertiary">
            {trailing}
          </span>
        ) : null}
      </span>
      {hint ? <span className="mt-1 block text-xs font-normal text-ink-tertiary">{hint}</span> : null}
    </label>
  )
})
