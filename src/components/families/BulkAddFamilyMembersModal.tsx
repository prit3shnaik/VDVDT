import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { FileSpreadsheet, Loader2, Search, UserPlus, X } from 'lucide-react'
import type { Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { compactLookupValue } from '../../lib/searchUtils'
import type { FamilyGroup } from '../../lib/searchUtils'
import {
  classifyEpicLines,
  collectUnresolvedOtherHeadEpics,
  parseEpicList,
  type BulkEpicLineResult,
  type BulkEpicStatus,
  type EpicLookupRow,
} from '../../lib/familyBulk'

export interface BulkAddFamilyMembersModalProps {
  headEpic: string
  headName: string | null | undefined
  members: Voter[]
  familyLookupByEpic: Map<string, FamilyGroup>
  profileId?: string | null
  onImported: () => Promise<void>
  onClose: () => void
}

type Phase = 'paste' | 'checking' | 'preview'

const LOOKUP_CHUNK = 80

const STATUS_META: Record<BulkEpicStatus, { label: string; badgeClass: string }> = {
  found: { label: 'Found', badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  notFound: { label: 'Not Found', badgeClass: 'border-rose-200 bg-rose-50 text-rose-700' },
  alreadyAssigned: { label: 'Already Assigned', badgeClass: 'border-line bg-muted text-ink-secondary' },
  inAnotherFamily: { label: 'In Another Family', badgeClass: 'border-amber-200 bg-amber-50 text-amber-700' },
  duplicate: { label: 'Duplicate', badgeClass: 'border-violet-200 bg-violet-50 text-violet-700' },
}

function formatLocation(row: EpicLookupRow): string {
  const parts = [row.ward_no != null ? `Ward ${row.ward_no}` : null, row.part_no != null ? `Part ${row.part_no}` : null, row.section != null ? `Section ${row.section}` : null]
    .filter(Boolean)
  return parts.length ? parts.join(' - ') : ''
}

export function BulkAddFamilyMembersModal({
  headEpic,
  headName,
  members,
  familyLookupByEpic,
  profileId,
  onImported,
  onClose,
}: BulkAddFamilyMembersModalProps) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('paste')
  const [results, setResults] = useState<BulkEpicLineResult[] | null>(null)
  const [committing, setCommitting] = useState(false)

  const parsed = useMemo(() => parseEpicList(text), [text])
  const uniqueCount = useMemo(() => parsed.filter((line) => !line.duplicate).length, [parsed])
  const duplicateCount = parsed.length - uniqueCount

  const counts = useMemo(() => {
    if (!results) return null
    const base: Record<BulkEpicStatus, number> = { found: 0, notFound: 0, alreadyAssigned: 0, inAnotherFamily: 0, duplicate: 0 }
    for (const result of results) {
      base[result.status] += 1
    }
    return base
  }, [results])

  const eligibleCount = counts?.found ?? 0

  const handleTextChange = (value: string) => {
    setText(value)
    setResults(null)
    setPhase('paste')
  }

  const checkEpics = async () => {
    if (!uniqueCount) {
      toast.error('Paste at least one EPIC number.')
      return
    }

    setPhase('checking')

    try {
      const targetHeadKey = compactLookupValue(headEpic)
      const uniqueEpics = parsed.filter((line) => !line.duplicate).map((line) => line.epic)
      const foundByEpic = new Map<string, EpicLookupRow>()

      for (let i = 0; i < uniqueEpics.length; i += LOOKUP_CHUNK) {
        const chunk = uniqueEpics.slice(i, i + LOOKUP_CHUNK)
        const { data, error } = await supabase
          .from('voters')
          .select('id, epic_no, name, family_head_epic, ward_no, part_no, section')
          .in('epic_no', chunk)
        if (error) {
          toast.error(error.message)
          setPhase('paste')
          return
        }
        for (const row of (data ?? []) as EpicLookupRow[]) {
          foundByEpic.set(compactLookupValue(row.epic_no), row)
        }
      }

      // Resolve names for the few "in another family" heads the page's family
      // lookup map can't see (out-of-scope wards) so the preview can still
      // name the family the voter belongs to.
      const unresolvedHeads = collectUnresolvedOtherHeadEpics(parsed, foundByEpic, targetHeadKey, familyLookupByEpic)
      const otherHeadNameByEpic = new Map<string, string>()
      for (let i = 0; i < unresolvedHeads.length; i += LOOKUP_CHUNK) {
        const chunk = unresolvedHeads.slice(i, i + LOOKUP_CHUNK)
        const { data, error } = await supabase.from('voters').select('epic_no, name').in('epic_no', chunk)
        if (error) {
          toast.error(error.message)
          setPhase('paste')
          return
        }
        for (const row of (data ?? []) as Array<{ epic_no: string; name: string }>) {
          otherHeadNameByEpic.set(compactLookupValue(row.epic_no), row.name)
        }
      }

      const classified = classifyEpicLines({
        lines: parsed,
        foundByEpic,
        targetHeadEpic: targetHeadKey,
        familyLookupByEpic,
        otherHeadNameByEpic,
      })
      setResults(classified)
      setPhase('preview')
    } catch {
      toast.error('Something went wrong while checking the EPIC numbers.')
      setPhase('paste')
    }
  }

  const commit = async () => {
    if (!results) return
    const eligible = results.filter((result) => result.status === 'found')
    if (!eligible.length) {
      toast.error('No eligible voters to add.')
      return
    }

    setCommitting(true)
    const headKey = compactLookupValue(headEpic)
    const existingNonHeadMembers = members.filter((member) => compactLookupValue(member.epic_no) !== headKey)
    const now = new Date().toISOString()

    // Re-compact display_order of existing non-head members (same hygiene as
    // the single-add flow), then append every new member after them in paste
    // order so the family table stays in a clean 1..n sequence.
    const reorderUpdates = existingNonHeadMembers.map((member, index) =>
      member.display_order === index + 1 ? null : supabase.from('voters').update({ display_order: index + 1 }).eq('id', member.id),
    )
    const memberUpdates = eligible.map((result, index) =>
      supabase
        .from('voters')
        .update({
          family_head_epic: headEpic,
          family_label: null,
          family_color: null,
          row_color: null,
          display_order: existingNonHeadMembers.length + index + 1,
          updated_at: now,
        })
        .eq('id', result.voter!.id),
    )

    const allUpdates = [...memberUpdates, ...reorderUpdates.filter((update): update is NonNullable<typeof update> => update != null)]
    const updateResults = await Promise.all(allUpdates)
    const firstError = updateResults.find((result) => result.error)?.error
    if (firstError) {
      toast.error(firstError.message)
      setCommitting(false)
      return
    }

    if (profileId) {
      const skipped = results.filter((result) => result.status !== 'found')
      await supabase.from('activity_logs').insert({
        actor_user_id: profileId,
        action: 'bulk_family_assign',
        target_table: 'voters',
        target_id: headEpic,
        details: {
          family_head: headEpic,
          added: eligible.length,
          counts,
          epics: eligible.map((result) => result.epic),
          not_found_epics: skipped.filter((result) => result.status === 'notFound').map((result) => result.epic),
          already_assigned_epics: skipped.filter((result) => result.status === 'alreadyAssigned').map((result) => result.epic),
          in_other_family_epics: skipped.filter((result) => result.status === 'inAnotherFamily').map((result) => result.epic),
          duplicate_epics: skipped.filter((result) => result.status === 'duplicate').map((result) => result.epic),
        },
      })
    }

    setCommitting(false)
    toast.success(`Added ${eligible.length} member${eligible.length === 1 ? '' : 's'} to ${headName ?? headEpic}'s family.`)
    onClose()
    await onImported()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FileSpreadsheet className="h-5 w-5 text-brand-600" />
              Add members by EPIC list
            </h3>
            <p className="mt-1 text-sm text-ink-tertiary">
              Adding to <span className="font-semibold text-ink-secondary">{headName ?? 'Family'}</span> ({headEpic}) - currently{' '}
              {members.length} member{members.length === 1 ? '' : 's'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={committing}
            className="rounded-lg p-1 text-ink-tertiary transition hover:bg-muted hover:text-ink-secondary disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {phase === 'checking' ? (
          <div className="flex flex-col items-center justify-center py-14 text-sm text-ink-tertiary">
            <Loader2 className="mb-3 h-6 w-6 animate-spin text-brand-600" />
            Checking EPIC numbers...
          </div>
        ) : null}

        {phase === 'paste' ? (
          <div className="flex flex-1 flex-col gap-4">
            <textarea
              className="h-56 w-full resize-y rounded-2xl border border-line bg-muted/60 p-4 font-mono text-sm text-ink outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              placeholder={'Paste EPIC numbers here, one per line.\n\nCopy the column straight from Excel and paste - duplicates are flagged in the preview.'}
              value={text}
              onChange={(event) => handleTextChange(event.target.value)}
              autoFocus
            />

            {parsed.length > 0 ? (
              <div className="rounded-2xl border border-line bg-muted px-4 py-3 text-sm">
                <p className="font-semibold text-ink">
                  {uniqueCount} EPIC number{uniqueCount === 1 ? '' : 's'} found
                  {duplicateCount > 0 ? (
                    <span className="ml-2 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700">
                      {duplicateCount} duplicate{duplicateCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 break-all text-xs text-ink-tertiary">
                  {parsed.slice(0, 6).map((line) => line.epic).join(', ')}
                  {parsed.length > 6 ? ` ... +${parsed.length - 6} more` : ''}
                </p>
              </div>
            ) : null}

            <div className="mt-auto flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!uniqueCount}
                onClick={() => void checkEpics()}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Search className="h-4 w-4" /> Check EPICs
              </button>
            </div>
          </div>
        ) : null}

        {phase === 'preview' && results && counts ? (
          <div className="flex flex-1 flex-col gap-4">
            <div className="grid grid-cols-5 gap-2">
              {(['found', 'notFound', 'alreadyAssigned', 'inAnotherFamily', 'duplicate'] as BulkEpicStatus[]).map((status) => (
                <div key={status} className={`rounded-2xl border px-2 py-2 text-center ${STATUS_META[status].badgeClass}`}>
                  <p className="text-lg font-bold">{counts[status]}</p>
                  <p className="text-[10px] font-semibold uppercase tracking-wider opacity-80">{STATUS_META[status].label}</p>
                </div>
              ))}
            </div>

            <div className="max-h-[46vh] flex-1 overflow-y-auto rounded-2xl border border-line">
              <table className="w-full min-w-[480px] text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-tertiary">EPIC</th>
                    <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-tertiary">Voter</th>
                    <th className="border-b border-line px-3 py-2 text-left font-semibold text-ink-tertiary">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {results.map((result, index) => {
                    const meta = STATUS_META[result.status]
                    return (
                      <tr key={`${result.epic}-${index}`} className="align-top">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-ink">{result.raw}</td>
                        <td className="px-3 py-2">
                          {result.voter ? (
                            <div>
                              <p className="font-medium text-ink">{result.voter.name}</p>
                              <p className="text-[11px] text-ink-tertiary">
                                {result.voter.epic_no}
                                {formatLocation(result.voter) ? ` - ${formatLocation(result.voter)}` : ''}
                              </p>
                            </div>
                          ) : (
                            <span className="text-ink-tertiary">-</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.badgeClass}`}>
                            {meta.label}
                          </span>
                          {result.otherFamilyLabel ? (
                            <p className="mt-1 text-[11px] text-ink-tertiary">
                              In <span className="font-semibold text-ink-secondary">{result.otherFamilyLabel}</span>'s family
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-auto flex justify-end gap-2">
              <button
                type="button"
                disabled={committing}
                onClick={() => setPhase('paste')}
                className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted disabled:opacity-50"
              >
                Edit list
              </button>
              <button
                type="button"
                disabled={committing}
                onClick={onClose}
                className="h-10 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink-secondary transition hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!eligibleCount || committing}
                onClick={() => void commit()}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Add {eligibleCount} voter{eligibleCount === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
