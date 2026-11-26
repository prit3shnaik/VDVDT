import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface StatCardProps {
  title: string
  value: string
  meta?: string
  icon?: ReactNode
  featured?: boolean
  tone?: 'neutral' | 'brand' | 'info' | 'success'
}

const toneIcon: Record<NonNullable<StatCardProps['tone']>, string> = {
  neutral: 'bg-muted text-ink-secondary',
  brand: 'bg-brand-50 text-brand-700',
  info: 'bg-[var(--info-fill)] text-[var(--info)]',
  success: 'bg-[var(--success-fill)] text-[var(--success)]',
}

export function StatCard({ title, value, meta, icon, featured = false, tone = 'neutral' }: StatCardProps) {
  return (
    <article
      className={cn(
        'relative overflow-hidden rounded-xl border border-line bg-white p-4 shadow-soft',
        featured && 'before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-[image:var(--kpi-hairline)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">{title}</p>
          <p className="mt-2 font-display text-[28px] font-semibold tabular-nums tracking-[-0.04em] text-ink">{value}</p>
          {meta ? <p className="mt-1.5 text-sm text-ink-secondary">{meta}</p> : null}
        </div>
        {icon ? (
          <span className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', toneIcon[tone])}>
            {icon}
          </span>
        ) : null}
      </div>
    </article>
  )
}
