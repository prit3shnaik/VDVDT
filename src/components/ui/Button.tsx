import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon'
type ButtonSize = 'default' | 'compact' | 'mobile'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  children?: ReactNode
}

const variantClass: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white shadow-sm hover:bg-brand-700 focus-visible:ring-brand-200 disabled:bg-brand-600',
  secondary:
    'border border-line bg-white text-ink shadow-sm hover:border-line-strong hover:bg-muted focus-visible:ring-brand-200',
  ghost:
    'bg-transparent text-ink-secondary hover:bg-muted hover:text-ink focus-visible:ring-brand-200',
  danger:
    'border border-[var(--danger-border)] bg-white text-[var(--danger)] hover:bg-[var(--danger-fill)] focus-visible:ring-rose-200',
  icon:
    'bg-transparent text-ink-secondary hover:bg-muted hover:text-ink focus-visible:ring-brand-200',
}

const sizeClass: Record<ButtonSize, string> = {
  default: 'h-10 px-4 text-sm',
  compact: 'h-9 px-3 text-sm',
  mobile: 'h-11 px-4 text-sm',
}

export function Button({
  variant = 'primary',
  size = 'default',
  loading = false,
  className,
  disabled,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  const iconOnly = variant === 'icon'

  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
        variantClass[variant],
        iconOnly ? 'h-8 w-8 px-0' : sizeClass[size],
        className,
      )}
      {...props}
    >
      {loading ? 'Loading...' : children}
    </button>
  )
}
