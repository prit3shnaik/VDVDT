import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Check, Loader2, Search, UserPlus, X } from 'lucide-react'
import type { Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import {
  initials,
  compactLookupValue,
  tokenizeLookup,
  normalizeGroupingValue,
  escapeIlikePattern,
  isLikelyEpicToken,
  highlightMatch,
} from '../../lib/searchUtils'
import { SelectedVoterChips } from '../voters/SelectedVoterChips'

type GroupRef = { id: string; name: string; parent_group_id: string | null; exclusive_subgroups: boolean }

interface MembershipEntry {
  groupId: string
  groupName: string
  parentGroupId: string | null
}

type MembershipConflict = { type: 'sibling'; groupName: string } | { type: 'other'; groupNames: string[] }

function getMembershipConflict(
  voterId: string,
  targetGroup: { id: string | null; parent_group_id: string | null },
  membershipByVoterId: Map<string, MembershipEntry[]>,
  groupsById: Map<string, GroupRef>,
): MembershipConflict | null {
  const memberships = membershipByVoterId.get(voterId) ?? []
  const relevant = memberships.filter((m) => m.groupId !== targetGroup.id)
  if (!relevant.length) return null

  if (targetGroup.parent_group_id) {
    const sibling = relevant.find((m) => m.parentGroupId === targetGroup.parent_group_id)
    if (sibling) {
      const parentGroup = groupsById.get(targetGroup.parent_group_id)
      if (parentGroup?.exclusive_subgroups !== false) {
        return { type: 'sibling', groupName: sibling.groupName }
      }
    }
  }

  return { type: 'other', groupNames: relevant.map((m) => m.groupName) }
}

function buildFamilyHeadEpic(voter: Voter): string {
  // Must return the RAW stored value - it is used in
  // .or('family_head_epic.eq.KEY,epic_no.eq.KEY') database filters, and
  // normalization that strips special characters (e.g. "ABC/123456" ->
  // "ABC 123456") would make those filters match nothing in the DB.
  if (voter.family_head_epic) return voter.family_head_epic.trim()
  return voter.epic_no.trim()
}

function vf(v: Voter, field: string): string {
  const value = (v as unknown as Record<string, unknown>)[field]
  return value === null || value === undefined ? '' : String(value)
}

function CheckboxUI({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border transition ${
        checked
          ? 'border-brand-500 bg-brand-500 text-white'
          : 'border-line bg-white hover:border-brand-400'
      }`}
      aria-checked={checked}
      role="checkbox"
    >
      {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </button>
  )
}

function VoterAvatar({ voter, photoUrl, size = 'sm' }: { voter: Voter; photoUrl?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'h-7 w-7 text-[9px]' : 'h-9 w-9 text-[10px]'
  if (photoUrl) {
    return <img src={photoUrl} alt={vf(voter, 'name')} className={`${dim} flex-shrink-0 rounded-full border border-line object-cover`} />
  }
  return (
    <span className={`${dim} inline-flex flex-shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700`}>
      {initials(vf(voter, 'name'))}
    </span>
  )
}

export interface AddMembersPanelProps {
  group: GroupRef
  voters: Voter[]
  groupsById: Map<string, GroupRef>
  membershipByVoterId: Map<string, MembershipEntry[]>
  photoUrlByPath: Record<string, string>
  profileId?: string
  onAdded: () => Promise<void>
  autoFocusSearch?: boolean
}

export function AddMembersPanel({
  group,
  voters,
  groupsById,
  membershipByVoterId,
  photoUrlByPath,
  profileId,
  onAdded,
  autoFocusSearch = false,
}: AddMembersPanelProps) {
  const [familyQuery, setFamilyQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [familyVoters, setFamilyVoters] = useState<Voter[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const [pendingMembers, setPendingMembers] = useState<Voter[]>([])

  // ----- Browse by part (family-wise) -----
  const [browsePart, setBrowsePart] = useState('')
  const [browseSelectedIds, setBrowseSelectedIds] = useState<Set<string>>(new Set())
  const [browseVisibleCount, setBrowseVisibleCount] = useState(20)

  const currentMemberIds = useMemo(() => {
    const set = new Set<string>()
    for (const [voterId, entries] of membershipByVoterId) {
      if (entries.some((e) => e.groupId === group.id)) set.add(voterId)
    }
    return set
  }, [membershipByVoterId, group.id])

  const allFamilies = useMemo(() => {
    const map = new Map<string, Voter[]>()
    for (const v of voters) {
      const key = buildFamilyHeadEpic(v)
      const list = map.get(key)
      if (list) list.push(v)
      else map.set(key, [v])
    }
    return Array.from(map.entries()).map(([headEpic, members]) => ({
      headEpic,
      headVoter: members.find((m) => normalizeGroupingValue(m.epic_no) === normalizeGroupingValue(headEpic)) ?? members[0] ?? null,
      members,
    }))
  }, [voters])

  const partOptions = useMemo(() => {
    return Array.from(new Set(voters.filter((v) => v.part_no != null).map((v) => v.part_no))).sort((a, b) => a! - b!)
  }, [voters])

  const familiesInBrowsePart = useMemo(() => {
    if (!browsePart) return []
    return allFamilies
      .filter((family) => String(family.headVoter?.part_no ?? '') === browsePart)
      .sort((a, b) => (a.headVoter?.name ?? '').localeCompare(b.headVoter?.name ?? ''))
  }, [allFamilies, browsePart])

  const visibleBrowseFamilies = familiesInBrowsePart.slice(0, browseVisibleCount)

  const familyTokens = useMemo(() => tokenizeLookup(familyQuery), [familyQuery])

  const toggleMember = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelectedIds(next)
  }

  const toggleBrowseMember = (id: string) => {
    const next = new Set(browseSelectedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setBrowseSelectedIds(next)
  }

  const addToPending = (members: Voter[]) => {
    setPendingMembers((prev) => {
      const seen = new Set(prev.map((v) => v.id))
      const merged = [...prev]
      for (const m of members) {
        if (seen.has(m.id)) continue
        if (currentMemberIds.has(m.id)) continue
        seen.add(m.id); merged.push(m)
      }
      return merged
    })
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setShowDropdown(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (autoFocusSearch) {
      const t = setTimeout(() => searchInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [autoFocusSearch])

  useEffect(() => {
    if (!familyQuery.trim()) { setFamilyVoters([]); return }
    let cancelled = false
    const run = async () => {
      setSearching(true)
      const trimmed = familyQuery.trim()
      const tokens = tokenizeLookup(trimmed)

      if (tokens.length === 1 && isLikelyEpicToken(tokens[0])) {
        const epicToken = compactLookupValue(tokens[0])
        const { data: exactRow } = await supabase.from('voters').select('*').eq('epic_no', epicToken).maybeSingle()
        if (cancelled) return
        if (exactRow) {
          const voter = exactRow as Voter
          const headEpic = buildFamilyHeadEpic(voter)
          const { data: familyRows } = await supabase.from('voters').select('*').or(`family_head_epic.eq.${headEpic},epic_no.eq.${headEpic}`)
          if (cancelled) return
          const all = (familyRows as Voter[] | null) ?? []
          const seen = new Set<string>(); const deduped: Voter[] = []
          for (const row of all) { const k = compactLookupValue(row.epic_no); if (k && !seen.has(k)) { seen.add(k); deduped.push(row) } }
          setFamilyVoters(deduped); setSelectedIds(new Set()); setSearching(false); return
        }
        setFamilyVoters([]); setSearching(false); return
      }

      const searchPattern = `%${escapeIlikePattern(trimmed).replace(/\s+/g, '%')}%`
      const { data: matchedRows } = await supabase.from('voters').select('*').or([
        `name.ilike.${searchPattern}`, `relative_name.ilike.${searchPattern}`, `epic_no.ilike.${searchPattern}`,
        `contact_no_1.ilike.${searchPattern}`, `house_no.ilike.${searchPattern}`,
      ].join(',')).limit(30)

      if (cancelled) return
      const matches = (matchedRows as Voter[] | null) ?? []
      if (!matches.length) { setFamilyVoters([]); setSearching(false); return }

      const seedRow = matches[0]
      const headEpic = buildFamilyHeadEpic(seedRow)
      const { data: familyRows } = await supabase.from('voters').select('*').or(`family_head_epic.eq.${headEpic},epic_no.eq.${headEpic}`)
      if (cancelled) return
      const all = (familyRows as Voter[] | null) ?? []
      const seen = new Set<string>(); const deduped: Voter[] = []
      for (const row of all) { const k = compactLookupValue(row.epic_no); if (k && !seen.has(k)) { seen.add(k); deduped.push(row) } }
      setFamilyVoters(deduped); setSelectedIds(new Set()); setSearching(false)
    }
    void run()
    return () => { cancelled = true }
  }, [familyQuery])

  const addSelectedMembers = () => {
    if (selectedIds.size === 0) { toast.error('Select at least one member.'); return }
    addToPending(familyVoters.filter((v) => selectedIds.has(v.id)))
    toast.success(`Added ${selectedIds.size} member(s). Search another family to add more.`)
    setFamilyQuery(''); setFamilyVoters([]); setSelectedIds(new Set()); setShowDropdown(false)
  }

  const addCheckedFromBrowsePart = () => {
    if (browseSelectedIds.size === 0) { toast.error('Select at least one member.'); return }
    const allBrowseMembers = familiesInBrowsePart.flatMap((f) => f.members)
    addToPending(allBrowseMembers.filter((v) => browseSelectedIds.has(v.id)))
    toast.success(`Added ${browseSelectedIds.size} member(s) from Part ${browsePart}.`)
    setBrowseSelectedIds(new Set())
  }

  const selectAllHeadsInBrowsePart = () => {
    const heads = familiesInBrowsePart.map((f) => f.headVoter).filter((v): v is Voter => v != null)
    addToPending(heads)
    toast.success(`Added ${heads.length} family head(s) from Part ${browsePart}.`)
  }

  const removePending = (id: string) => {
    setPendingMembers((prev) => prev.filter((v) => v.id !== id))
  }

  const save = async () => {
    if (pendingMembers.length === 0) { toast.error('Select at least one member.'); return }
    setSaving(true)
    const rows = pendingMembers.map((v) => ({ group_id: group.id, voter_id: v.id, added_by: profileId ?? null }))
    const { error } = await supabase.from('group_members').insert(rows)
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Added ${pendingMembers.length} member(s) to "${group.name}".`)
    setPendingMembers([]); setFamilyVoters([]); setSelectedIds(new Set()); setFamilyQuery('')
    setBrowsePart(''); setBrowseSelectedIds(new Set())
    await onAdded()
  }

  const headVoter = familyVoters.length > 0 ? (familyVoters.find((v) => normalizeGroupingValue(v.epic_no) === normalizeGroupingValue(buildFamilyHeadEpic(familyVoters[0]))) ?? familyVoters[0]) : null
  const targetGroupRef = { id: group.id, parent_group_id: group.parent_group_id }

  return (
    <div className="rounded-2xl border border-line bg-muted/60 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
        Add members to <span className="text-brand-600">{group.name}</span>
      </p>

      <div ref={containerRef} className="relative">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
          <input ref={searchInputRef} className="h-11 w-full rounded-xl border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            placeholder="Search a family by name, EPIC, relative name, mobile, house..." value={familyQuery}
            onChange={(e) => { setFamilyQuery(e.target.value); if (!showDropdown) setShowDropdown(true) }}
            onFocus={() => { if (familyQuery.trim()) setShowDropdown(true) }} />
          {familyQuery && (
            <button type="button" onClick={() => { setFamilyQuery(''); setFamilyVoters([]); setSelectedIds(new Set()) }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {showDropdown && familyQuery.trim() && searching && (
          <div className="absolute z-30 mt-2 w-full rounded-xl border border-line bg-white p-4">
            <div className="flex items-center justify-center gap-2 text-sm text-ink-tertiary"><Loader2 className="h-4 w-4 animate-spin" /> Searching families...</div>
          </div>
        )}

        {showDropdown && familyQuery.trim() && !searching && familyVoters.length === 0 && (
          <div className="absolute z-30 mt-2 w-full rounded-xl border border-line bg-white p-6 text-center">
            <p className="text-sm text-ink-tertiary">No families found. Try a different search.</p>
          </div>
        )}

        {showDropdown && familyQuery.trim() && !searching && familyVoters.length > 0 && (
          <div className="absolute z-30 mt-2 w-full max-h-[60vh] overflow-y-auto rounded-xl border border-line">
            <div className="overflow-hidden rounded-xl bg-white">
              <div className="border-b border-line bg-muted/70 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                  <span className="font-semibold text-ink">{headVoter?.name ?? 'Unknown'}</span>
                  <span>EPIC: {buildFamilyHeadEpic(familyVoters[0])}</span>
                  <span>Part: {headVoter?.part_no ?? '-'}</span>
                  <span>Section: {headVoter?.section ?? '-'}</span>
                  <span>Members: {familyVoters.length}</span>
                </div>
              </div>

              <div className="divide-y divide-line">
                {familyVoters.map((member) => {
                  const alreadyMember = currentMemberIds.has(member.id)
                  const conflict = alreadyMember ? null : getMembershipConflict(member.id, targetGroupRef, membershipByVoterId, groupsById)
                  const blocked = !alreadyMember && conflict?.type === 'sibling'
                  const checked = selectedIds.has(member.id) || alreadyMember
                  const photo = member.photo_url ? photoUrlByPath[member.photo_url] : undefined
                  return (
                    <button key={member.id} type="button" disabled={alreadyMember || blocked}
                      onClick={() => !blocked && !alreadyMember && toggleMember(member.id)}
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-muted ${alreadyMember || blocked ? 'opacity-50' : ''}`}>
                      {alreadyMember ? <span className="flex-shrink-0 text-[10px] font-semibold text-emerald-600">Added</span>
                        : blocked ? <span className="flex-shrink-0 text-[10px] font-semibold text-rose-600" title={`Already in ${conflict!.groupName}`}>Blocked</span>
                        : <CheckboxUI checked={checked} onChange={() => toggleMember(member.id)} />}
                      <VoterAvatar voter={member} photoUrl={photo} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">
                          {highlightMatch(member.name, familyTokens)}
                          {conflict ? (
                            <span className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${conflict.type === 'sibling' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>
                              {conflict.type === 'sibling' ? `In ${conflict.groupName} \u00b7 remove first` : `Also in: ${conflict.groupNames.join(', ')}`}
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-ink-tertiary">
                          EPIC: {member.epic_no}{member.house_no ? ` \u00b7 House ${member.house_no}` : ''}{member.relative_name ? ` \u00b7 ${member.relative_name}` : ''}
                        </p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-line bg-white px-4 py-2.5">
              <p className="text-sm text-ink-secondary">
                <span className="font-semibold text-ink">{selectedIds.size}</span> of {familyVoters.length} selected
              </p>
              <button type="button" disabled={selectedIds.size === 0} onClick={addSelectedMembers}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                <UserPlus className="h-4 w-4" /> Add Selected Members
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Or Browse a Part</label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            value={browsePart}
            onChange={(e) => { setBrowsePart(e.target.value); setBrowseVisibleCount(20); setBrowseSelectedIds(new Set()) }}
          >
            <option value="">Select part...</option>
            {partOptions.map((p) => (
              <option key={p} value={String(p)}>Part {p}</option>
            ))}
          </select>
          {browsePart ? (
            <button type="button" className="text-xs font-semibold text-brand-600 hover:text-brand-800"
              onClick={() => { setBrowsePart(''); setBrowseSelectedIds(new Set()) }}>
              Clear
            </button>
          ) : null}
        </div>

        {browsePart && (
          <div className="mt-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-ink-tertiary">
                {familiesInBrowsePart.length} famil{familiesInBrowsePart.length === 1 ? 'y' : 'ies'} in Part {browsePart}
                {familiesInBrowsePart.length > browseVisibleCount ? ` \u00b7 showing first ${browseVisibleCount}` : ''}
              </p>
              {familiesInBrowsePart.length ? (
                <button type="button" className="text-xs font-semibold text-brand-600 hover:text-brand-800"
                  onClick={selectAllHeadsInBrowsePart} title="Adds only the family head of every family in this part">
                  Select all family heads in Part {browsePart}
                </button>
              ) : null}
            </div>

            {!familiesInBrowsePart.length ? (
              <p className="rounded-xl border border-line bg-muted p-4 text-center text-sm text-ink-tertiary">
                No families found in Part {browsePart}.
              </p>
            ) : (
              <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded-xl border border-line p-2">
                {visibleBrowseFamilies.map((family) => {
                  const familyChecked = family.members.length > 0 && family.members.every((m) => browseSelectedIds.has(m.id) || currentMemberIds.has(m.id))
                  return (
                    <div key={family.headEpic} className="overflow-hidden rounded-xl border border-line bg-white">
                      <div className="flex flex-wrap items-start gap-3 border-b border-line bg-muted/70 px-3 py-2.5">
                        <div className="min-w-[180px] flex-1">
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700">Family Head</span>
                          <p className="mt-0.5 text-sm font-semibold text-ink">{family.headVoter?.name ?? 'Unknown'}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-tertiary">
                            <span>EPIC: {family.headEpic}</span>
                            <span>Section: {family.headVoter?.section ?? '-'}</span>
                            <span>Members: {family.members.length}</span>
                          </div>
                        </div>
                        <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                          <CheckboxUI
                            checked={familyChecked}
                            onChange={(v) => {
                              setBrowseSelectedIds((prev) => {
                                const next = new Set(prev)
                                for (const m of family.members) {
                                  if (currentMemberIds.has(m.id)) continue
                                  if (v) next.add(m.id); else next.delete(m.id)
                                }
                                return next
                              })
                            }}
                          />
                          Whole family
                        </label>
                      </div>
                      <div className="divide-y divide-line">
                        {family.members.map((member) => {
                          const alreadyMember = currentMemberIds.has(member.id)
                          const conflict = alreadyMember ? null : getMembershipConflict(member.id, targetGroupRef, membershipByVoterId, groupsById)
                          const blocked = !alreadyMember && conflict?.type === 'sibling'
                          return (
                            <button key={member.id} type="button" disabled={alreadyMember || blocked}
                              onClick={() => !blocked && !alreadyMember && toggleBrowseMember(member.id)}
                              className={`flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-muted ${alreadyMember || blocked ? 'opacity-50' : ''}`}>
                              <CheckboxUI checked={browseSelectedIds.has(member.id) || alreadyMember} onChange={() => !blocked && !alreadyMember && toggleBrowseMember(member.id)} />
                              <VoterAvatar voter={member} photoUrl={member.photo_url ? photoUrlByPath[member.photo_url] : undefined} size="sm" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-ink">{member.name}</p>
                                <p className="truncate text-xs text-ink-tertiary">
                                  EPIC: {member.epic_no}{member.house_no ? ` \u00b7 House ${member.house_no}` : ''}
                                </p>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {familiesInBrowsePart.length > browseVisibleCount ? (
              <button type="button" onClick={() => setBrowseVisibleCount((c) => c + 20)}
                className="mt-2 w-full rounded-xl border border-dashed border-line py-2 text-sm font-semibold text-brand-600 hover:bg-brand-50/60">
                Load 20 more families
              </button>
            ) : null}

            <div className="mt-2 flex items-center justify-between rounded-xl border border-line bg-muted px-4 py-2.5">
              <p className="text-sm text-ink-secondary">
                <span className="font-semibold text-ink">{browseSelectedIds.size}</span> selected in this part
              </p>
              <button type="button" disabled={browseSelectedIds.size === 0} onClick={addCheckedFromBrowsePart}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                <UserPlus className="h-4 w-4" /> Add Selected Members
              </button>
            </div>
          </div>
        )}
      </div>

      {pendingMembers.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">
              <span className="text-brand-600">{pendingMembers.length}</span> Selected Member{pendingMembers.length === 1 ? '' : 's'}
            </p>
            <button type="button" onClick={() => setPendingMembers([])}
              className="text-xs font-medium text-rose-600 hover:text-rose-700">Clear all</button>
          </div>
          <div className="mt-2">
            <SelectedVoterChips voters={pendingMembers} photoUrlByPath={photoUrlByPath} onRemove={removePending} />
          </div>
          <div className="mt-3 flex items-center justify-end">
            <button type="button" disabled={saving} onClick={() => void save()}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Add to {group.name}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
