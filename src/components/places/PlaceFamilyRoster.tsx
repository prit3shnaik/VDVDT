import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Check, ChevronDown, ChevronRight, Eye, Loader2, MapPin, MoreHorizontal, Phone, Search, UserPlus } from 'lucide-react'
import { ClassificationBadges } from '../families/ClassificationBadges'
import { PresencePicker } from '../families/PresencePicker'
import { FloatingDropdown } from '../common/FloatingDropdown'
import { TransferFamilyConfirmModal } from '../common/TransferFamilyConfirmModal'
import { VoterDetailDrawer } from '../voters/VoterDetailDrawer'
import { usePhotoUrls } from '../../hooks/usePhotoUrls'
import { placeClubLabel } from '../../lib/placeClubs'
import type { SlimFamilyVoter } from '../../lib/placeClubs'
import { presenceLabel, presenceNoteOf } from '../../lib/presence'
import { initials } from '../../lib/searchUtils'
import {
  assignFamilyToLeader,
  clearTeamLeaderDetailCache,
  clearTeamLeadersListCache,
  clearUnassignedDataCache,
  transferFamilyToLeader,
  type UnassignedLeaderOption,
} from '../../lib/teamLeaderCache'
import { familyLeaderId, toPlaceVoter, type SlimFamily } from '../../lib/placeWorkbench'
import type { PlaceClub, PresenceStatus, Voter } from '../../lib/types'
import { cn } from '../../lib/utils'

function CheckboxUI({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onChange(!checked) }}
      className={cn(
        'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border transition',
        checked ? 'border-brand-500 bg-brand-500 text-white' : 'border-line bg-white hover:border-brand-400',
      )}
      aria-checked={checked}
      role="checkbox"
    >
      {checked ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
    </button>
  )
}

function VoterAvatar({ voter, photoUrl, size = 'md' }: { voter: SlimFamilyVoter; photoUrl?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'h-8 w-8 text-[10px]' : 'h-9 w-9 text-xs'
  if (photoUrl) {
    return <img src={photoUrl} alt={voter.name} className={`${dim} flex-shrink-0 rounded-full border border-line object-cover`} />
  }
  return (
    <span className={`${dim} inline-flex flex-shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700`}>
      {initials(voter.name)}
    </span>
  )
}

function filterLeaderOptions(options: UnassignedLeaderOption[], query: string): UnassignedLeaderOption[] {
  const token = query.trim().toLowerCase()
  if (!token) return options
  return options.filter((option) =>
    option.name.toLowerCase().includes(token) || option.epicNo.toLowerCase().includes(token),
  )
}

function LeaderCombobox({
  options,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  options: UnassignedLeaderOption[]
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => filterLeaderOptions(options, query), [options, query])
  return (
    <div className="flex min-w-[14rem] flex-1 overflow-hidden rounded-lg border border-line bg-white focus-within:border-brand-300">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
        <input
          className="h-9 w-full bg-transparent pl-7 pr-2 text-sm outline-none disabled:opacity-60"
          placeholder="Search leader"
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <select
        className="h-9 max-w-[12rem] border-l border-line bg-transparent px-2 text-sm outline-none disabled:opacity-60"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {matches.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}{option.part_no != null ? ` · Part ${option.part_no}` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

export function PlaceFamilyRoster({
  families,
  canEdit,
  selectedFamilyKeys,
  onToggleFamily,
  onSelectAll,
  allMatchingCount,
  onSelectAllMatching,
  voterToLeaderId,
  specialIds,
  leaderNameById,
  leaderOptions,
  assignedBy,
  placeClub,
  clubs,
  saving,
  unlabelledMode,
  onMove,
  onUnclub,
  onUnclubFamily,
  onMoveFamily,
  onLeaderAssigned,
  onVoterPatched,
  onPresenceSaved,
  savingPresenceKey,
  areaSuggestions = [],
}: {
  families: SlimFamily[]
  canEdit: boolean
  selectedFamilyKeys: Set<string>
  onToggleFamily: (key: string) => void
  onSelectAll: (keys: string[]) => void
  allMatchingCount?: number
  onSelectAllMatching?: () => void
  voterToLeaderId: Record<string, string>
  specialIds: Set<string>
  leaderNameById: Record<string, string>
  leaderOptions: UnassignedLeaderOption[]
  assignedBy: string | null
  placeClub?: PlaceClub | null
  clubs: PlaceClub[]
  saving?: boolean
  unlabelledMode?: boolean
  onMove: (placeClubId: string) => void
  onUnclub: () => void
  onUnclubFamily: (family: SlimFamily) => void
  onMoveFamily: (family: SlimFamily, placeClubId: string) => void
  onLeaderAssigned: (voterIds: string[], leaderId: string) => void
  onVoterPatched: (voterId: string, patch: Partial<SlimFamilyVoter>) => void
  onPresenceSaved: (family: SlimFamily, status: PresenceStatus | null, note: string) => void
  savingPresenceKey?: string | null
  areaSuggestions?: string[]
}) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [assigningFamilyKey, setAssigningFamilyKey] = useState<string | null>(null)
  const [bulkLeaderId, setBulkLeaderId] = useState('')
  const [bulkAssigning, setBulkAssigning] = useState(false)
  const [transferTarget, setTransferTarget] = useState<{
    families: SlimFamily[]
    toLeaderId: string
    sourceName: string
  } | null>(null)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [placeQuery, setPlaceQuery] = useState('')
  const [menuFamilyKey, setMenuFamilyKey] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null)
  const [presenceMenuFamily, setPresenceMenuFamily] = useState<string | null>(null)
  const [presenceAnchor, setPresenceAnchor] = useState<HTMLButtonElement | null>(null)

  const photoPaths = useMemo(
    () => Array.from(new Set(families.flatMap((family) => family.members.map((member) => member.photo_url).filter((path): path is string => Boolean(path))))),
    [families],
  )
  const photoUrlByPath = usePhotoUrls(photoPaths)
  const resolvePhotoUrl = useCallback((voter: SlimFamilyVoter | null | undefined) => {
    if (!voter?.photo_url) return ''
    return photoUrlByPath[voter.photo_url] ?? ''
  }, [photoUrlByPath])

  const realLeaderId = useCallback((family: SlimFamily) => familyLeaderId(family, voterToLeaderId, specialIds), [specialIds, voterToLeaderId])

  const allSelected = families.length > 0 && families.every((family) => selectedFamilyKeys.has(family.key))
  const selectedFamilies = families.filter((family) => selectedFamilyKeys.has(family.key))
  const matchingPlaceClubs = useMemo(() => {
    const token = placeQuery.trim().toLowerCase()
    const available = clubs.filter((club) => club.id !== placeClub?.id)
    if (!token) return available
    return available.filter((club) => placeClubLabel(club).toLowerCase().includes(token) || (club.area ?? '').toLowerCase().includes(token))
  }, [clubs, placeClub?.id, placeQuery])

  const applyAssignment = async (targetFamilies: SlimFamily[], toLeaderId: string) => {
    const voterIds: string[] = []
    const transferIds: string[] = []
    const assignIds: string[] = []
    const directForAssign = new Set<string>()
    for (const family of targetFamilies) {
      const current = realLeaderId(family)
      const direct = family.headVoter ?? family.members[0]
      for (const member of family.members) voterIds.push(member.id)
      if (current && current !== toLeaderId) {
        transferIds.push(...family.members.map((member) => member.id))
      } else if (!current) {
        for (const member of family.members) {
          assignIds.push(member.id)
          if (direct && member.id === direct.id) directForAssign.add(member.id)
        }
      }
    }
    if (!voterIds.length) {
      toast.error('No voters to assign.')
      return
    }
    if (assignIds.length) {
      await assignFamilyToLeader({
        voterIds: assignIds,
        toLeaderId,
        assignedBy,
        isDirectVoterIds: directForAssign,
        specialLeaderIds: specialIds,
      })
    }
    if (transferIds.length) {
      await transferFamilyToLeader({ voterIds: transferIds, toLeaderId, assignedBy })
    }
    const changed = [...assignIds, ...transferIds]
    if (!changed.length) {
      toast.error('Those families are already on this team leader.')
      return
    }
    onLeaderAssigned(changed, toLeaderId)
    clearTeamLeadersListCache()
    clearTeamLeaderDetailCache()
    clearUnassignedDataCache()
    const leaderName = leaderNameById[toLeaderId] ?? 'team leader'
    toast.success(`Assigned ${targetFamilies.length} famil${targetFamilies.length === 1 ? 'y' : 'ies'} to ${leaderName}.`)
  }

  const requestAssign = async (targetFamilies: SlimFamily[], toLeaderId: string) => {
    if (!toLeaderId || !targetFamilies.length) return
    const sources = Array.from(new Set(
      targetFamilies.map((family) => realLeaderId(family)).filter((id): id is string => Boolean(id) && id !== toLeaderId),
    ))
    if (sources.length) {
      setTransferTarget({
        families: targetFamilies,
        toLeaderId,
        sourceName: sources.map((id) => leaderNameById[id] || 'another team leader').join(', '),
      })
      return
    }
    await applyAssignment(targetFamilies, toLeaderId)
  }

  const assignOne = async (family: SlimFamily, toLeaderId: string) => {
    if (!toLeaderId || toLeaderId === realLeaderId(family)) return
    setAssigningFamilyKey(family.key)
    try {
      await requestAssign([family], toLeaderId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not assign family.')
    } finally {
      setAssigningFamilyKey(null)
    }
  }

  const assignBulk = async () => {
    if (!selectedFamilies.length) {
      toast.error('Select one or more families first.')
      return
    }
    if (!bulkLeaderId) {
      toast.error('Select a team leader first.')
      return
    }
    setBulkAssigning(true)
    try {
      await requestAssign(selectedFamilies, bulkLeaderId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not assign families.')
    } finally {
      setBulkAssigning(false)
    }
  }

  const confirmTransfer = async () => {
    if (!transferTarget) return
    setBulkAssigning(true)
    setAssigningFamilyKey(transferTarget.families.length === 1 ? transferTarget.families[0].key : null)
    try {
      await applyAssignment(transferTarget.families, transferTarget.toLeaderId)
      setTransferTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not transfer families.')
    } finally {
      setBulkAssigning(false)
      setAssigningFamilyKey(null)
    }
  }

  const toggleExpanded = (key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (!families.length) return null

  return (
    <div>
      {canEdit && selectedFamilies.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-muted px-4 py-2.5">
          <span className="text-xs font-semibold text-ink-secondary">{selectedFamilies.length} selected</span>
          <button
            type="button"
            onClick={() => onSelectAll([])}
            className="h-8 rounded-lg px-2 text-xs font-semibold text-ink-tertiary transition hover:bg-white hover:text-ink-secondary"
          >
            Clear
          </button>
          {onSelectAllMatching && (allMatchingCount ?? 0) > selectedFamilies.length ? (
            <button
              type="button"
              onClick={onSelectAllMatching}
              className="h-8 rounded-lg px-2 text-xs font-semibold text-brand-700 transition hover:bg-white"
            >
              Select all matching ({allMatchingCount})
            </button>
          ) : null}
          <LeaderCombobox
            options={leaderOptions}
            value={bulkLeaderId}
            onChange={setBulkLeaderId}
            placeholder="Assign to…"
            disabled={bulkAssigning}
          />
          <button
            type="button"
            disabled={bulkAssigning || !bulkLeaderId}
            onClick={() => void assignBulk()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {bulkAssigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
            Assign
          </button>
          <div className="flex min-w-[16rem] overflow-hidden rounded-lg border border-line bg-white">
            <input
              className="h-8 min-w-0 flex-1 px-2 text-xs outline-none"
              placeholder="Search place"
              value={placeQuery}
              onChange={(event) => setPlaceQuery(event.target.value)}
            />
            <select
              className="h-8 max-w-[12rem] border-l border-line bg-transparent px-2 text-xs font-semibold text-ink-secondary outline-none"
              value=""
              onChange={(event) => {
                const value = event.target.value
                if (value) onMove(value)
              }}
            >
              <option value="">Move to a place…</option>
              {matchingPlaceClubs.map((club) => (
                <option key={club.id} value={club.id}>{placeClubLabel(club)}</option>
              ))}
            </select>
          </div>
          {!unlabelledMode ? (
            <button
              type="button"
              disabled={saving}
              onClick={onUnclub}
              className="h-8 rounded-lg px-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
            >
              Unclub
            </button>
          ) : null}
        </div>
      ) : canEdit ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <p className="text-xs text-ink-tertiary">{unlabelledMode ? 'Select families to club into a place or assign a leader.' : 'Select families to assign a leader, move, or unclub.'}</p>
          <div className="flex items-center gap-1">
            {onSelectAllMatching && (allMatchingCount ?? 0) > families.length ? (
              <button
                type="button"
                onClick={onSelectAllMatching}
                className="h-8 rounded-lg px-2 text-xs font-semibold text-brand-700 transition hover:bg-muted"
              >
                Select all matching ({allMatchingCount})
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onSelectAll(allSelected ? [] : families.map((family) => family.key))}
              className="h-8 rounded-lg px-2 text-xs font-semibold text-ink-tertiary transition hover:bg-muted hover:text-ink-secondary"
            >
              {allSelected ? 'Clear selection' : 'Select page'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="divide-y divide-line">
        {families.map((family) => {
          const head = family.headVoter ?? family.members[0]
          const selected = selectedFamilyKeys.has(family.key)
          const expanded = expandedKeys.has(family.key)
          const currentLeaderId = realLeaderId(family)
          const currentLeaderName = currentLeaderId ? (leaderNameById[currentLeaderId] || 'Team leader') : ''
          const assigning = assigningFamilyKey === family.key
          const presence = presenceLabel(head?.presence_status)
          const note = presenceNoteOf(head)
          return (
            <article key={family.key} className={cn(selected && 'bg-brand-50/50')}>
              <div className="flex items-start gap-2.5 px-4 py-2.5">
                {canEdit ? <CheckboxUI checked={selected} onChange={() => onToggleFamily(family.key)} /> : null}
                <button type="button" onClick={() => toggleExpanded(family.key)} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
                  {head ? <VoterAvatar voter={head} photoUrl={resolvePhotoUrl(head)} /> : null}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-ink">{head?.name ?? family.head}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-ink-tertiary">
                        {family.members.length} member{family.members.length === 1 ? '' : 's'}
                      </span>
                      <span
                        className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold text-teal-700"
                        title={note ? `${presence ?? 'Presence'} — ${note}` : (presence ?? 'Presence not set')}
                      >
                        {presence ?? 'Not set'}
                      </span>
                      {currentLeaderId ? (
                        <Link
                          to={`/team-leaders/${currentLeaderId}`}
                          onClick={(event) => event.stopPropagation()}
                          className="hidden max-w-[10rem] truncate rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 md:inline"
                        >
                          {currentLeaderName}
                        </Link>
                      ) : (
                        <span className="hidden rounded-full border border-dashed border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-700 sm:inline">
                          Unassigned
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-tertiary">
                      EPIC {head?.epic_no ?? family.head}
                      {head?.part_no != null ? ` · Part ${head.part_no}` : ''}
                    </span>
                    {note && !expanded ? (
                      <span className="mt-1 line-clamp-2 block whitespace-pre-wrap text-xs text-ink-secondary" title={note}>{note}</span>
                    ) : null}
                  </span>
                  {expanded ? <ChevronDown className="mt-1 h-4 w-4 flex-shrink-0 text-ink-tertiary" /> : <ChevronRight className="mt-1 h-4 w-4 flex-shrink-0 text-ink-tertiary" />}
                </button>
                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <PresencePicker
                      status={head?.presence_status ?? null}
                      note={note}
                      heading="Classify family presence"
                      compact
                      showPrefix={false}
                      showCompactNote={false}
                      areaSuggestions={areaSuggestions}
                      saving={savingPresenceKey === family.key}
                      open={presenceMenuFamily === family.key}
                      anchor={presenceMenuFamily === family.key ? presenceAnchor : null}
                      onToggle={(button) => {
                        setMenuFamilyKey(null)
                        setPresenceAnchor(button)
                        setPresenceMenuFamily((current) => (current === family.key ? null : family.key))
                      }}
                      onClose={() => setPresenceMenuFamily(null)}
                      onSave={(status, nextNote) => onPresenceSaved(family, status, nextNote)}
                      onClear={() => onPresenceSaved(family, null, '')}
                    />
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        setPresenceMenuFamily(null)
                        setMenuAnchor(event.currentTarget)
                        setMenuFamilyKey((current) => (current === family.key ? null : family.key))
                      }}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-tertiary transition hover:bg-muted hover:text-ink-secondary"
                      aria-label={`Actions for ${head?.name ?? family.head}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                    <FloatingDropdown
                      open={menuFamilyKey === family.key}
                      onClose={() => setMenuFamilyKey(null)}
                      anchor={menuFamilyKey === family.key ? menuAnchor : null}
                      className="w-56 overflow-hidden rounded-xl border border-line bg-white p-1.5"
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted"
                        onClick={() => {
                          setMenuFamilyKey(null)
                          setExpandedKeys((current) => new Set(current).add(family.key))
                        }}
                      >
                        <UserPlus className="h-3.5 w-3.5" /> Assign leader
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-secondary transition hover:bg-muted"
                        onClick={() => {
                          setMenuFamilyKey(null)
                          setExpandedKeys((current) => new Set(current).add(family.key))
                        }}
                      >
                        <MapPin className="h-3.5 w-3.5" /> Move to a place…
                      </button>
                      {!unlabelledMode ? (
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-rose-600 transition hover:bg-rose-50"
                          onClick={() => {
                            setMenuFamilyKey(null)
                            onUnclubFamily(family)
                          }}
                        >
                          Unclub
                        </button>
                      ) : null}
                    </FloatingDropdown>
                  </div>
                ) : null}
              </div>

              {expanded ? (
                <div className="border-t border-line bg-white px-4 py-3">
                  {note ? (
                    <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">{note}</p>
                  ) : null}
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <ClassificationBadges members={family.members} head={head} placeClub={placeClub ?? null} />
                    {canEdit && leaderOptions.length ? (
                      <div className="ml-auto flex min-w-[16rem] items-center gap-2">
                        <LeaderCombobox
                          options={leaderOptions}
                          value=""
                          onChange={(value) => { if (value) void assignOne(family, value) }}
                          placeholder={currentLeaderId ? 'Change leader…' : 'Assign leader…'}
                          disabled={assigning}
                        />
                        {assigning ? <Loader2 className="h-4 w-4 animate-spin text-ink-tertiary" /> : null}
                      </div>
                    ) : null}
                  </div>
                  {canEdit ? (
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <select
                        className="h-9 min-w-[14rem] rounded-lg border border-line bg-white px-2 text-sm text-ink-secondary outline-none"
                        value=""
                        onChange={(event) => {
                          const value = event.target.value
                          if (value) onMoveFamily(family, value)
                        }}
                      >
                        <option value="">{unlabelledMode ? 'Move to a place…' : 'Move to another place…'}</option>
                        {clubs.filter((club) => club.id !== placeClub?.id).map((club) => (
                          <option key={club.id} value={club.id}>{placeClubLabel(club)}</option>
                        ))}
                      </select>
                      {!unlabelledMode ? (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => onUnclubFamily(family)}
                          className="h-9 rounded-lg px-3 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                        >
                          Unclub family
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="min-w-full text-xs">
                      <thead className="bg-muted text-ink-tertiary">
                        <tr>
                          <th className="w-12 px-3 py-2 text-left font-semibold">Photo</th>
                          <th className="min-w-[140px] px-3 py-2 text-left font-semibold">Name</th>
                          <th className="w-28 px-3 py-2 text-left font-semibold">EPIC</th>
                          <th className="w-16 px-3 py-2 text-left font-semibold">Part</th>
                          <th className="w-28 px-3 py-2 text-left font-semibold">Contact</th>
                          <th className="w-16 px-3 py-2 text-right font-semibold"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {family.members.map((member) => {
                          const isHead = head != null && member.id === head.id
                          const contact = member.contact_no_1 || member.contact_no_2
                          return (
                            <tr key={member.id} className={cn('border-t border-line hover:bg-muted', isHead && 'bg-brand-50/30')}>
                              <td className="px-3 py-2">
                                <VoterAvatar voter={member} photoUrl={resolvePhotoUrl(member)} size="sm" />
                              </td>
                              <td className="px-3 py-2">
                                <span className="flex items-center gap-1.5">
                                  {isHead ? <span className="rounded bg-brand-100 px-1 py-px text-[10px] font-semibold uppercase text-brand-700">Head</span> : null}
                                  <span className="truncate font-medium text-ink">{member.name}</span>
                                </span>
                              </td>
                              <td className="px-3 py-2 text-ink-tertiary">{member.epic_no || '-'}</td>
                              <td className="px-3 py-2 text-ink-tertiary">{member.part_no ?? '-'}</td>
                              <td className="px-3 py-2 text-ink-tertiary">{contact || '-'}</td>
                              <td className="px-3 py-2">
                                <span className="flex items-center justify-end gap-1">
                                  {contact ? (
                                    <a href={`tel:${contact}`} title="Call" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-tertiary hover:bg-muted">
                                      <Phone className="h-3.5 w-3.5" />
                                    </a>
                                  ) : null}
                                  <button
                                    type="button"
                                    title="View voter"
                                    onClick={() => setSelectedVoter(toPlaceVoter(member))}
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-tertiary hover:bg-muted"
                                  >
                                    <Eye className="h-3.5 w-3.5" />
                                  </button>
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </article>
          )
        })}
      </div>

      <TransferFamilyConfirmModal
        open={transferTarget !== null}
        headName={transferTarget?.families.length === 1
          ? (transferTarget.families[0].headVoter?.name ?? transferTarget.families[0].head)
          : `${transferTarget?.families.length ?? 0} families`}
        memberCount={transferTarget?.families.reduce((sum, family) => sum + family.members.length, 0) ?? 0}
        sourceLeaderName={transferTarget?.sourceName}
        targetLeaderName={transferTarget ? (leaderNameById[transferTarget.toLeaderId] ?? 'this team leader') : ''}
        transferring={bulkAssigning || Boolean(assigningFamilyKey)}
        onClose={() => { if (!bulkAssigning) setTransferTarget(null) }}
        onConfirm={() => { void confirmTransfer() }}
      />

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => {
          if (selectedVoter) onVoterPatched(selectedVoter.id, selectedVoter)
        }}
      />
    </div>
  )
}
