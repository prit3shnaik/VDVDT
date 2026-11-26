import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description: string
  action?: ReactNode
}

export function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-[-0.03em] text-ink md:text-[28px]">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-tertiary">{description}</p>
      </div>
      {action}
    </div>
  )
}
