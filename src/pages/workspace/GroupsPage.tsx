import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FolderOpen,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/Button'
import { AddMembersPanel } from '../../components/groups/AddMembersPanel'
import { CreateHeaderGroupModal } from '../../components/groups/CreateHeaderGroupModal'
import { EpicExcelImportModal } from '../../components/common/EpicExcelImportModal'
import type { Group, GroupMember, Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { loadAllVoters } from '../../lib/voterDataset'
import { highlightMatch, initials, matchesLookupTokens, normalizeLookupValue, tokenizeLookup } from '../../lib/searchUtils'

type GroupRow = Group & {
  parent_group_id: string | null
  exclusive_subgroups: boolean
}

interface MembershipEntry {
  groupId: string
  groupName: string
  parentGroupId: string | null
}

function formatDate(value: unknown): string {
  if (!value) return '-'
  try {
    const d = new Date(value as string)
    if (Number.isNaN(d.getTime())) return '-'
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '-' }
}

function IconButton({ onClick, title, variant = 'default', children, disabled }: {
  onClick: (e?: React.MouseEvent) => void; title: string; variant?: 'default' | 'danger' | 'primary'; children: React.ReactNode; disabled?: boolean
}) {
  const base = 'inline-flex h-9 w-9 items-center justify-center rounded-xl border transition disabled:cursor-not-allowed disabled:opacity-50'
  const styles =
    variant === 'danger' ? 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
    : variant === 'primary' ? 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
    : 'border-line bg-white text-ink-secondary hover:bg-muted'
  return <button type="button" title={title} onClick={(e) => { e.stopPropagation(); onClick(e) }} disabled={disabled} className={`${base} ${styles}`}>{children}</button>
}

// ── RenameGroupModal ───────────────────────────────────────────────────

function RenameGroupModal({ group, onClose, onSaved }: { group: GroupRow | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(group?.name ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setName(group?.name ?? '') }, [group])
  if (!group) return null

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) { toast.error('Group name is required.'); return }
    setSaving(true)
    const { error } = await supabase.from('groups').update({ name: trimmed }).eq('id', group.id)
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success('Group renamed.')
    await onSaved(); onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-ink">Rename Group</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <label className="block text-sm text-ink-secondary">
          Group Name
          <input autoFocus className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} loading={saving} onClick={() => void save()}>Save</Button>
        </div>
      </div>
    </div>
  )
}

// ── DeleteGroupModal ───────────────────────────────────────────────────

function DeleteGroupModal({ group, memberCount, subGroupCount, onClose, onConfirm }: {
  group: GroupRow | null
  memberCount: number
  subGroupCount?: number
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  useEffect(() => { setConfirmName('') }, [group])
  if (!group) return null

  const isHeader = group.parent_group_id === null
  const matches = confirmName.trim().toLowerCase() === group.name.trim().toLowerCase()
  const scopeText = isHeader && subGroupCount
    ? `its ${subGroupCount} sub-group${subGroupCount === 1 ? '' : 's'} and ${memberCount} member${memberCount === 1 ? '' : 's'}`
    : `its ${memberCount} member${memberCount === 1 ? '' : 's'}`
  const kind = isHeader ? 'group' : 'sub-group'

  const confirm = async () => {
    if (!matches || deleting) return
    setDeleting(true)
    await onConfirm()
    setDeleting(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
              <Trash2 className="h-4 w-4" />
            </span>
            <h3 className="text-lg font-semibold text-ink">Delete {kind}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm leading-6 text-ink-secondary">
          This permanently deletes <span className="font-semibold text-ink">&ldquo;{group.name}&rdquo;</span> and {scopeText}. This cannot be undone. To confirm, type the {kind} name below.
        </p>
        <label className="mt-4 block text-sm text-ink-secondary">
          Type <span className="font-semibold text-ink">&ldquo;{group.name}&rdquo;</span> to confirm
          <input autoFocus className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
            value={confirmName} onChange={(e) => setConfirmName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void confirm() }} />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!matches || deleting} loading={deleting} onClick={() => void confirm()}>
            Delete {kind}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── AddSubGroupForm ────────────────────────────────────────────────────

function AddSubGroupForm({ parentName, onCancel, onCreate }: {
  parentName: string
  onCancel: () => void
  onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { toast.error('Sub-group name is required.'); return }
    setSaving(true)
    await onCreate(trimmed)
    setSaving(false)
  }

  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
        New sub-group under <span className="text-brand-600">{parentName}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input autoFocus className="h-10 min-w-[200px] flex-1 rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          placeholder="e.g. Mahila Mandal" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
        <Button disabled={saving} loading={saving} onClick={() => void submit()}>
          <Plus className="h-4 w-4" /> Create
        </Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────

export function GroupsPage() {
  const { profile, isAdminAreaAllowed } = useAuth()
  const navigate = useNavigate()
  const [voters, setVoters] = useState<Voter[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([])
  const [loading, setLoading] = useState(true)
  const [votersLoading, setVotersLoading] = useState(false)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})
  const [renameGroup, setRenameGroup] = useState<GroupRow | null>(null)
  const [showCreateHeader, setShowCreateHeader] = useState(false)
  const [groupSearch, setGroupSearch] = useState('')
  const [openMenuGroupId, setOpenMenuGroupId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null)
  const [expandedHeaders, setExpandedHeaders] = useState<Set<string>>(new Set())
  const [addingSubGroupFor, setAddingSubGroupFor] = useState<string | null>(null)
  const [activeAddPanel, setActiveAddPanel] = useState<string | null>(null)
  const [autofocusAddPanelId, setAutofocusAddPanelId] = useState<string | null>(null)
  const [importTarget, setImportTarget] = useState<GroupRow | null>(null)
  const newSubGroupRef = useRef<HTMLDivElement>(null)

  const allowedWards = useMemo(() => {
    const wards = Array.from(new Set((profile?.allowed_wards ?? []).filter((w) => Number.isFinite(w)))); wards.sort((a, b) => a - b); return wards
  }, [profile?.allowed_wards])
  const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

  const votersLoadStartedRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [grRes, gmRes] = await Promise.all([
      supabase.from('groups').select('*').order('created_at', { ascending: false }),
      supabase.from('group_members').select('group_id,voter_id'),
    ])
    if (grRes.error) toast.error(grRes.error.message)
    if (gmRes.error) toast.error(gmRes.error.message)
    setGroups((grRes.data as GroupRow[] | null) ?? [])
    setGroupMembers((gmRes.data as GroupMember[] | null) ?? [])
    setLoading(false)
  }, [])

  const ensureVotersLoaded = useCallback(async () => {
    if (votersLoadStartedRef.current) return
    votersLoadStartedRef.current = true
    setVotersLoading(true)
    try {
      const rows = await loadAllVoters({
        role: profile?.role,
        allowedWards: profile?.allowed_wards,
        onFirstBatch: (batch) => setVoters(batch),
      })
      setVoters(rows)
    } catch (error) {
      votersLoadStartedRef.current = false
      toast.error(error instanceof Error ? error.message : 'Voter load failed')
    } finally {
      setVotersLoading(false)
    }
  }, [profile?.allowed_wards, profile?.role])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (activeAddPanel) void ensureVotersLoaded()
  }, [activeAddPanel, ensureVotersLoaded])

  useEffect(() => {
    if (groups.some((group) => group.group_type === 'part_wise')) void ensureVotersLoaded()
  }, [groups, ensureVotersLoaded])

  const voterById = useMemo(() => { const m = new Map<string, Voter>(); for (const v of voters) m.set(v.id, v); return m }, [voters])
  const groupsById = useMemo(() => { const m = new Map<string, GroupRow>(); for (const g of groups) m.set(g.id, g); return m }, [groups])
  const memberIdsByGroupId = useMemo(() => {
    const m = new Map<string, Set<string>>(); for (const gm of groupMembers) { const s = m.get(gm.group_id); if (s) s.add(gm.voter_id); else m.set(gm.group_id, new Set([gm.voter_id])) }; return m
  }, [groupMembers])

  const customGroupMembershipByVoterId = useMemo(() => {
    const map = new Map<string, MembershipEntry[]>()
    for (const gm of groupMembers) {
      const group = groupsById.get(gm.group_id)
      if (!group || group.group_type !== 'custom') continue
      const entry: MembershipEntry = { groupId: group.id, groupName: group.name, parentGroupId: group.parent_group_id }
      const list = map.get(gm.voter_id)
      if (list) list.push(entry)
      else map.set(gm.voter_id, [entry])
    }
    return map
  }, [groupMembers, groupsById])

  const memberCountByGroupId = useMemo(() => {
    const map = new Map<string, number>()
    const partCounts = new Map<number, number>()
    const needsPartCounts = groups.some((group) => group.group_type === 'part_wise')
    if (needsPartCounts) {
      for (const voter of voters) {
        if (voter.part_no == null) continue
        partCounts.set(voter.part_no, (partCounts.get(voter.part_no) ?? 0) + 1)
      }
    }
    for (const group of groups) {
      if (group.group_type === 'part_wise') {
        map.set(group.id, group.part_no != null ? (partCounts.get(group.part_no) ?? 0) : 0)
      } else {
        map.set(group.id, memberIdsByGroupId.get(group.id)?.size ?? 0)
      }
    }
    return map
  }, [groups, voters, memberIdsByGroupId])

  const headers = useMemo(() => groups.filter((g) => !g.parent_group_id), [groups])

  const subGroupsByParentId = useMemo(() => {
    const m = new Map<string, GroupRow[]>()
    for (const g of groups) {
      if (!g.parent_group_id) continue
      const list = m.get(g.parent_group_id)
      if (list) list.push(g)
      else m.set(g.parent_group_id, [g])
    }
    return m
  }, [groups])

  const groupSearchTokens = useMemo(() => tokenizeLookup(groupSearch), [groupSearch])

  const subGroupSearchResults = useMemo(() => {
    if (!groupSearchTokens.length) return []
    const matches: Array<{ group: GroupRow; parent: GroupRow | null }> = []
    for (const g of groups) {
      if (!g.parent_group_id) continue
      const parent = groupsById.get(g.parent_group_id) ?? null
      const text = normalizeLookupValue([g.name, parent?.name ?? ''].join(' '))
      if (matchesLookupTokens(text, groupSearchTokens)) {
        matches.push({ group: g, parent })
        if (matches.length >= 50) break
      }
    }
    return matches
  }, [groups, groupsById, groupSearchTokens])

  const visiblePhotoPaths = useMemo(() => {
    if (!activeAddPanel) return []
    const set = new Set<string>()
    const memberIds = memberIdsByGroupId.get(activeAddPanel)
    if (memberIds) {
      for (const id of memberIds) {
        const v = voterById.get(id)
        if (v?.photo_url) set.add(v.photo_url)
      }
    }
    return Array.from(set)
  }, [activeAddPanel, memberIdsByGroupId, voterById])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const missing = visiblePhotoPaths.filter((p) => !photoUrlByPath[p])
      if (!missing.length) return
      for (let i = 0; i < missing.length; i += 80) {
        if (cancelled) return
        const batch = missing.slice(i, i + 80)
        const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
        if (cancelled || !data) continue
        const next: Record<string, string> = {}
        for (let j = 0; j < batch.length; j++) { const url = data[j]?.signedUrl; if (url) next[batch[j]] = url }
        if (Object.keys(next).length) setPhotoUrlByPath((c) => ({ ...c, ...next }))
      }
    }
    void run(); return () => { cancelled = true }
  }, [photoUrlByPath, visiblePhotoPaths])

  const toggleExpanded = (headerId: string) => {
    setExpandedHeaders((prev) => {
      const next = new Set(prev)
      if (next.has(headerId)) next.delete(headerId)
      else next.add(headerId)
      return next
    })
  }

  const createSubGroup = async (parentId: string, name: string) => {
    const { data: newGroup, error: gErr } = await supabase.from('groups').insert({
      name, group_type: 'custom', part_no: null, description: null, created_by: profile?.id ?? null, parent_group_id: parentId,
    }).select('id').single()
    if (gErr || !newGroup) { toast.error(gErr?.message ?? 'Failed to create sub-group.'); return }
    toast.success(`Sub-group "${name}" created.`)
    setAddingSubGroupFor(null)
    await load()
    setExpandedHeaders((prev) => { const next = new Set(prev); next.add(parentId); return next })
    setActiveAddPanel(newGroup.id)
    setAutofocusAddPanelId(newGroup.id)
    setTimeout(() => newSubGroupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }

  const performDelete = async (group: GroupRow) => {
    const subIds = subGroupsByParentId.get(group.id)?.map((s) => s.id) ?? []
    if (subIds.length) {
      const { error: mErr } = await supabase.from('group_members').delete().in('group_id', subIds)
      if (mErr) { toast.error(mErr.message); return }
      const { error: sErr } = await supabase.from('groups').delete().in('id', subIds)
      if (sErr) { toast.error(sErr.message); return }
    }
    const { error: hmErr } = await supabase.from('group_members').delete().eq('group_id', group.id)
    if (hmErr) { toast.error(hmErr.message); return }
    const { error } = await supabase.from('groups').delete().eq('id', group.id)
    if (error) { toast.error(error.message); return }
    toast.success('Group deleted.')
    setExpandedHeaders((prev) => { const next = new Set(prev); next.delete(group.id); return next })
    await load()
  }

  const totalMemberCount = useMemo(() => {
    let total = 0
    for (const count of memberCountByGroupId.values()) total += count
    return total
  }, [memberCountByGroupId])

  const renderSubGroup = (sub: GroupRow) => {
    const isAdding = activeAddPanel === sub.id
    return (
      <div key={sub.id} className="rounded-2xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-sm font-semibold text-brand-700">{initials(sub.name)}</div>
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink">{sub.name}</p>
              <p className="text-xs text-ink-tertiary">Created {formatDate(sub.created_at)}</p>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-ink-secondary">
              <Users className="h-3.5 w-3.5" /> {memberCountByGroupId.get(sub.id) ?? 0}
            </span>
            <IconButton title={isAdding ? 'Close member search' : 'Add members'} variant="primary" onClick={() => setActiveAddPanel(isAdding ? null : sub.id)}>
              <UserPlus className="h-4 w-4" />
            </IconButton>
            <IconButton title="Import voters from Excel" variant="primary" onClick={() => setImportTarget(sub)}>
              <FileSpreadsheet className="h-4 w-4" />
            </IconButton>
            <IconButton title="Open group" onClick={() => navigate('/groups/' + sub.id)}><ChevronRight className="h-4 w-4" /></IconButton>
            <IconButton title="Rename" onClick={() => setRenameGroup(sub)}><Pencil className="h-4 w-4" /></IconButton>
            <div className="relative">
              <IconButton title="More options" onClick={() => setOpenMenuGroupId(openMenuGroupId === sub.id ? null : sub.id)}>
                <MoreVertical className="h-4 w-4" />
              </IconButton>
              {openMenuGroupId === sub.id && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setOpenMenuGroupId(null)} />
                  <div className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-2xl border border-line bg-white p-1.5">
                    {isAdminAreaAllowed ? (
                      <button
                        type="button"
                        onClick={() => { setOpenMenuGroupId(null); setDeleteTarget(sub) }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold text-rose-600 transition hover:bg-rose-50"
                      >
                        <Trash2 className="h-4 w-4" /> Delete sub-group
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {isAdding && (
          <div className="mt-4">
            {votersLoading && !voters.length ? (
              <div className="flex items-center gap-2 rounded-2xl border border-line bg-muted px-3 py-3 text-sm text-ink-tertiary">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading voters for add members...
              </div>
            ) : (
              <AddMembersPanel
                group={sub}
                voters={voters}
                groupsById={groupsById}
                membershipByVoterId={customGroupMembershipByVoterId}
                photoUrlByPath={photoUrlByPath}
                profileId={profile?.id}
                onAdded={load}
                autoFocusSearch={autofocusAddPanelId === sub.id}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  const renderHeader = (header: GroupRow) => {
    const isExpanded = expandedHeaders.has(header.id)
    const subs = subGroupsByParentId.get(header.id) ?? []
    const subTotal = subs.reduce((acc, s) => acc + (memberCountByGroupId.get(s.id) ?? 0), 0)
    const headerDirect = header.group_type === 'part_wise' ? memberCountByGroupId.get(header.id) ?? 0 : 0
    const shownTotal = header.group_type === 'part_wise' ? headerDirect + subTotal : subTotal

    return (
      <section key={header.id} className="overflow-hidden rounded-xl border border-line bg-white">
        <div
          className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-5 py-4 transition hover:bg-muted"
          onClick={() => toggleExpanded(header.id)}
        >
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleExpanded(header.id) }}
              className="flex-shrink-0 rounded-lg p-0.5 text-ink-tertiary hover:bg-muted"
              title={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
            </button>
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-ink-secondary">
              <FolderOpen className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-ink">{header.name}</p>
              {header.description && <p className="truncate text-xs text-ink-tertiary">{header.description}</p>}
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">Header</span>
                {header.group_type === 'part_wise' && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">Auto Part {header.part_no}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-3">
            <div className="text-right text-xs text-ink-tertiary">
              <p><span className="font-semibold text-ink">{subs.length}</span> sub-group{subs.length === 1 ? '' : 's'}</p>
              <p><span className="font-semibold text-ink">{shownTotal}</span> members</p>
            </div>
            <IconButton title="Add sub-group" variant="primary" onClick={() => setAddingSubGroupFor(header.id)}><Plus className="h-4 w-4" /></IconButton>
            <IconButton title="Rename" onClick={() => setRenameGroup(header)}><Pencil className="h-4 w-4" /></IconButton>
            {isAdminAreaAllowed ? (
              <IconButton title="Delete" variant="danger" onClick={() => setDeleteTarget(header)}><Trash2 className="h-4 w-4" /></IconButton>
            ) : null}
          </div>
        </div>

        {isExpanded && (
          <div className="border-t border-line bg-muted/40 p-4">
            {subs.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line py-3 text-center text-sm text-ink-tertiary">
                No sub-groups yet. Create one to start adding voters.
              </p>
            ) : (
              <div className="space-y-3">
                {subs.map((s) => renderSubGroup(s))}
              </div>
            )}

            <div className="mt-4">
              {addingSubGroupFor === header.id ? (
                <AddSubGroupForm
                  parentName={header.name}
                  onCancel={() => setAddingSubGroupFor(null)}
                  onCreate={(name) => createSubGroup(header.id, name)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingSubGroupFor(header.id)}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line py-2.5 text-sm font-medium text-ink-secondary transition hover:border-brand-300 hover:bg-muted hover:text-ink"
                >
                  <Plus className="h-4 w-4" /> Add sub-group to &ldquo;{header.name}&rdquo;
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    )
  }

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="Groups"
        description="Groups act as headers. Create a group, then add sub-groups under it to organise and manage voters."
        action={
          <Button onClick={() => setShowCreateHeader(true)}>
            <Plus className="h-4 w-4" /> New Group
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700">
          <FolderOpen className="h-3.5 w-3.5" /> {headers.length} group{headers.length === 1 ? '' : 's'}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold text-ink-secondary">
          <Users className="h-3.5 w-3.5" /> {totalMemberCount} member{totalMemberCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
        <input
          className="h-11 w-full rounded-2xl border border-line bg-white pl-10 pr-9 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          placeholder="Search sub-groups by name..."
          value={groupSearch}
          onChange={(e) => setGroupSearch(e.target.value)}
        />
        {groupSearch && (
          <button type="button" onClick={() => setGroupSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Clear search">
            <X className="h-4 w-4" />
          </button>
        )}
        {groupSearch.trim() && (
          <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto rounded-2xl border border-line bg-white p-2">
            {subGroupSearchResults.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-ink-tertiary">No sub-groups match &ldquo;{groupSearch}&rdquo;.</p>
            ) : (
              <p className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
                {subGroupSearchResults.length} sub-group{subGroupSearchResults.length === 1 ? '' : 's'} found
              </p>
            )}
            <div className="space-y-0.5">
              {subGroupSearchResults.map(({ group, parent }) => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => navigate('/groups/' + group.id)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-muted"
                >
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-xs font-semibold text-brand-700">
                    {initials(group.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{highlightMatch(group.name, groupSearchTokens)}</p>
                    <p className="truncate text-xs text-ink-tertiary">
                      {parent ? `in ${parent.name}` : 'Header group'}
                      <span className="mx-1.5">&middot;</span>
                      {memberCountByGroupId.get(group.id) ?? 0} member{memberCountByGroupId.get(group.id) === 1 ? '' : 's'}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-ink-tertiary" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div ref={newSubGroupRef} className="space-y-5">
        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading groups...</div>
        ) : headers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-white px-6 py-16 text-center">
            <FolderOpen className="mx-auto h-10 w-10 text-ink-tertiary" />
            <p className="mt-3 text-sm font-semibold text-ink">No groups yet</p>
            <p className="mt-1 text-sm text-ink-tertiary">Create a group header first, then add sub-groups and voters inside it.</p>
            <Button className="mt-4" onClick={() => setShowCreateHeader(true)}>
              <Plus className="h-4 w-4" /> New Group
            </Button>
          </div>
        ) : (
          headers.map((h) => renderHeader(h))
        )}
      </div>

      {showCreateHeader && (
        <CreateHeaderGroupModal
          onClose={() => setShowCreateHeader(false)}
          onSaved={async (id) => {
            await load()
            setExpandedHeaders((prev) => { const next = new Set(prev); next.add(id); return next })
          }}
        />
      )}
      <RenameGroupModal group={renameGroup} onClose={() => setRenameGroup(null)} onSaved={load} />
      <DeleteGroupModal
        group={deleteTarget}
        memberCount={deleteTarget ? (memberCountByGroupId.get(deleteTarget.id) ?? 0) : 0}
        subGroupCount={deleteTarget ? (subGroupsByParentId.get(deleteTarget.id)?.length ?? 0) : undefined}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return
          await performDelete(deleteTarget)
          setDeleteTarget(null)
        }}
      />

      {importTarget ? (
        <EpicExcelImportModal
          title={`Import voters to "${importTarget.name}"`}
          description="Upload an .xlsx file with one EPIC per row. Matching voters are added to this sub-group; voters already in it are skipped."
          targetTable="group_members"
          targetId={importTarget.id}
          targetLabel={importTarget.name}
          existingVoterIds={memberIdsByGroupId.get(importTarget.id) ?? new Set<string>()}
          wardRestriction={hasWardRestriction ? allowedWards : undefined}
          profileId={profile?.id}
          onCommit={async (rows) => {
            if (!rows.length) return null
            const { error } = await supabase.from('group_members').insert(
              rows.map((row) => ({ group_id: importTarget.id, voter_id: row.voter_id, added_by: profile?.id ?? null })),
            )
            return error?.message ?? null
          }}
          onImported={load}
          onClose={() => setImportTarget(null)}
        />
      ) : null}
    </div>
  )
}
