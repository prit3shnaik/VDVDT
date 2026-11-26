import { useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, Loader2, Search, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

export interface TransferLeaderOption {
  id: string
  name: string
  part_no: number | null
  section: number | null
}

interface TransferFamilyConfirmModalProps {
  open: boolean
  headName: string
  memberCount: number
  sourceLeaderName?: string
  targetLeaderName: string
  transferring: boolean
  onClose: () => void
  onConfirm: () => void
}

export function formatLeaderNames(names: Array<string | undefined | null>): string {
  const cleaned = names.map((name) => name?.trim()).filter((name): name is string => Boolean(name))
  if (!cleaned.length) return 'another team leader'
  if (cleaned.length === 1) return cleaned[0]
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`
  return `${cleaned.slice(0, -1).join(', ')} and ${cleaned[cleaned.length - 1]}`
}

export function TransferFamilyConfirmModal({
  open,
  headName,
  memberCount,
  sourceLeaderName,
  targetLeaderName,
  transferring,
  onClose,
  onConfirm,
}: TransferFamilyConfirmModalProps) {
  const source = sourceLeaderName?.trim() || 'another team leader'

  return (
    <Dialog open={open} onClose={transferring ? () => undefined : onClose} labelledBy="transfer-family-title">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--warning-fill)] text-[var(--warning)]">
              <ArrowLeftRight className="h-4 w-4" />
            </span>
            <h3 id="transfer-family-title" className="text-lg font-semibold text-ink">Transfer family</h3>
          </div>
          <Button variant="icon" onClick={onClose} disabled={transferring} aria-label="Close">
            <X className="h-5 w-5" />
          </Button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          <span className="font-semibold text-ink">&ldquo;{headName}&rdquo;</span>
          {memberCount > 1 ? ` (${memberCount} members) ` : ' '}
          is currently assigned to <span className="font-semibold text-ink">{source}</span>. Move this family to{' '}
          <span className="font-semibold text-ink">{targetLeaderName}</span>?
        </p>
        <p className="mt-2 text-xs text-ink-tertiary">
          Assigned members move to {targetLeaderName}. Any unassigned members in this family are assigned too. This cannot be undone from here.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={transferring}>Cancel</Button>
          <Button disabled={transferring} loading={transferring} onClick={onConfirm}>
            <ArrowLeftRight className="h-4 w-4" /> Transfer
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

interface BulkTransferModalProps {
  open: boolean
  familyCount: number
  voterCount: number
  sourceLeaderName: string
  leaders: TransferLeaderOption[]
  transferring: boolean
  onClose: () => void
  onConfirm: (targetLeaderId: string) => void
}

export function BulkTransferModal({
  open,
  familyCount,
  voterCount,
  sourceLeaderName,
  leaders,
  transferring,
  onClose,
  onConfirm,
}: BulkTransferModalProps) {
  const [search, setSearch] = useState('')
  const [partFilter, setPartFilter] = useState('')
  const [selectedId, setSelectedId] = useState('')

  useEffect(() => {
    if (!open) return
    setSearch('')
    setPartFilter('')
    setSelectedId('')
  }, [open])

  const partOptions = useMemo(() => {
    const parts = new Set(leaders.map((tl) => tl.part_no).filter((part): part is number => part !== null && part !== undefined))
    return Array.from(parts).sort((a, b) => a - b)
  }, [leaders])

  const filteredLeaders = useMemo(() => {
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return leaders.filter((tl) => {
      if (partFilter && (tl.part_no == null || String(tl.part_no) !== partFilter)) return false
      if (!tokens.length) return true
      const haystack = `${tl.name} ${tl.part_no ?? ''} ${tl.section ?? ''}`.toLowerCase()
      return tokens.every((token) => haystack.includes(token))
    })
  }, [leaders, search, partFilter])

  const selected = leaders.find((tl) => tl.id === selectedId)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg max-h-[90vh] flex-col rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
              <ArrowLeftRight className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Transfer families</h3>
          </div>
          <button type="button" onClick={onClose} disabled={transferring} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary disabled:opacity-50" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          Move <span className="font-semibold text-ink">{familyCount}</span> famil{familyCount === 1 ? 'y' : 'ies'}{' '}
          (<span className="font-semibold text-ink">{voterCount}</span> voter{voterCount === 1 ? '' : 's'}) from{' '}
          <span className="font-semibold text-ink">{sourceLeaderName || 'this team leader'}</span> to another team leader?
        </p>
        <p className="mt-2 text-xs text-ink-tertiary">
          Choose a destination, then confirm. Assigned members are reassigned; this cannot be undone from here.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
            <input
              className="h-10 w-full rounded-xl border border-line bg-white pl-8 pr-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              placeholder="Search team leaders..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={transferring}
            />
          </div>
          <select
            value={partFilter}
            onChange={(e) => setPartFilter(e.target.value)}
            disabled={transferring}
            className="h-10 flex-shrink-0 rounded-xl border border-line bg-white px-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          >
            <option value="">All Parts</option>
            {partOptions.map((part) => (
              <option key={part} value={String(part)}>Part {part}</option>
            ))}
          </select>
        </div>

        {selected && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700">Destination</p>
              <p className="truncate text-sm font-semibold text-ink">{selected.name}</p>
              <p className="text-[11px] text-ink-tertiary">
                {selected.part_no != null ? `Part ${selected.part_no}` : 'No part'}{selected.section != null ? ` · Sec ${selected.section}` : ''}
              </p>
            </div>
            <button
              type="button"
              disabled={transferring}
              onClick={() => setSelectedId('')}
              className="rounded-lg p-1 text-ink-tertiary hover:bg-white hover:text-ink-secondary disabled:opacity-50"
              aria-label="Clear destination"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line">
          {filteredLeaders.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-ink-tertiary">No matching team leaders.</p>
          ) : (
            filteredLeaders.map((tl) => {
              const active = tl.id === selectedId
              return (
                <button
                  key={tl.id}
                  type="button"
                  disabled={transferring}
                  onClick={() => setSelectedId(tl.id)}
                  className={`block w-full border-b border-line px-3 py-2.5 text-left text-sm transition last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50 ${
                    active ? 'bg-amber-50' : 'hover:bg-muted'
                  }`}
                >
                  <span className={`block font-semibold ${active ? 'text-amber-800' : 'text-ink-secondary'}`}>{tl.name}</span>
                  <span className="block text-[11px] font-medium text-ink-tertiary">
                    {tl.part_no != null ? `Part ${tl.part_no}` : 'No part'}{tl.section != null ? ` · Sec ${tl.section}` : ''}
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={transferring}
            className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected || transferring}
            onClick={() => { if (selected) onConfirm(selected.id) }}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-amber-600 px-5 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {transferring ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />}
            {selected ? `Transfer to ${selected.name}` : 'Transfer'}
          </button>
        </div>
      </div>
    </div>
  )
}
