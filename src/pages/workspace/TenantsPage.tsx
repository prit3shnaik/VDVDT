import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import toast from 'react-hot-toast'
import {
  ChevronDown,
  ChevronRight,
  Download,
  Home,
  Loader2,
  Pencil,
  Plus,
  Printer,
  Search,
  SlidersHorizontal,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { MobileSheet } from '../../components/common/MobileSheet'
import { ReportConfigModal, type ReportFieldDef as ReportModalFieldDef, type ReportFieldItem } from '../../components/common/ReportConfigModal'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { useAuth } from '../../hooks/useAuth'
import { useIsMobile } from '../../hooks/useIsMobile'
import { usePersistentState } from '../../hooks/usePersistentState'
import { usePhotoUrls } from '../../hooks/usePhotoUrls'
import type {
  Landlord,
  LandlordGroup,
  PresenceStatus,
  TenantCounts,
  TenantLinkRow,
  TenantVoter,
  Voter,
} from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { initials } from '../../lib/searchUtils'
import { PRESENCE_OPTIONS, presenceLabel } from '../../lib/presence'
import { DEFAULT_PRINT_STYLE, downloadPdfTable, exportRowsToExcel, handlePrint, type PrintStyleOptions, type ReportFieldDef } from '../../lib/reportBuilder'
import {
  assignTenant,
  createLandlord,
  deleteLandlord,
  fetchLandlords,
  fetchTenantList,
  groupTenantLinks,
  landlordEpic,
  landlordHouseNo,
  landlordIsOffRoll,
  landlordPart,
  landlordSection,
  landlordWard,
  moveTenant,
  removeTenantLink,
  searchAssignableVoters,
  searchLandlordCandidates,
  searchVoterCandidates,
  tenantGroupHeading,
  updateLandlord,
  type LandlordFilterParams,
  type LandlordKind,
  type TenantFilterParams,
  type TenantScope,
} from '../../lib/tenantLinks'

interface TenantReportRow {
  groupKey: string
  srNo: string
  photo: string
  photoPath: string
  tenantName: string
  tenantEpic: string
  room: string
  houseNo: string
  landlordName: string
  landlordEpic: string
  ward: string
  part: string
  section: string
  sectionName: string
  age: string
  gender: string
  contact1: string
  contact2: string
  relativeName: string
  relation: string
  presence: string
  familyLabel: string
  notes: string
}

const TENANT_REPORT_FIELD_DEFS: ReportModalFieldDef[] = [
  { key: 'srNo', label: 'Sr No' },
  { key: 'photo', label: 'Photo' },
  { key: 'tenantName', label: 'Tenant name' },
  { key: 'tenantEpic', label: 'Tenant EPIC' },
  { key: 'room', label: 'Room' },
  { key: 'houseNo', label: 'House no' },
  { key: 'landlordName', label: 'Landlord name' },
  { key: 'landlordEpic', label: 'Landlord EPIC' },
  { key: 'ward', label: 'Ward' },
  { key: 'part', label: 'Part' },
  { key: 'section', label: 'Section' },
  { key: 'sectionName', label: 'Section name' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'contact1', label: 'Contact 1' },
  { key: 'contact2', label: 'Contact 2' },
  { key: 'relativeName', label: 'Relative name' },
  { key: 'relation', label: 'Relation' },
  { key: 'presence', label: 'Presence' },
  { key: 'familyLabel', label: 'Family label' },
  { key: 'notes', label: 'Notes' },
]

const DEFAULT_TENANT_REPORT_FIELDS: ReportFieldItem[] = [
  { key: 'srNo', enabled: true },
  { key: 'photo', enabled: true },
  { key: 'tenantName', enabled: true },
  { key: 'tenantEpic', enabled: false },
  { key: 'room', enabled: true },
  { key: 'houseNo', enabled: true },
  { key: 'landlordName', enabled: true },
  { key: 'landlordEpic', enabled: false },
  { key: 'ward', enabled: false },
  { key: 'part', enabled: false },
  { key: 'section', enabled: false },
  { key: 'sectionName', enabled: false },
  { key: 'age', enabled: false },
  { key: 'gender', enabled: false },
  { key: 'contact1', enabled: true },
  { key: 'contact2', enabled: false },
  { key: 'relativeName', enabled: false },
  { key: 'relation', enabled: false },
  { key: 'presence', enabled: false },
  { key: 'familyLabel', enabled: false },
  { key: 'notes', enabled: false },
]

const TENANT_REPORT_GETTERS: Record<string, (row: TenantReportRow) => string> = {
  srNo: (row) => row.srNo,
  photo: (row) => row.photo,
  tenantName: (row) => row.tenantName,
  tenantEpic: (row) => row.tenantEpic,
  room: (row) => row.room,
  houseNo: (row) => row.houseNo,
  landlordName: (row) => row.landlordName,
  landlordEpic: (row) => row.landlordEpic,
  ward: (row) => row.ward,
  part: (row) => row.part,
  section: (row) => row.section,
  sectionName: (row) => row.sectionName,
  age: (row) => row.age,
  gender: (row) => row.gender,
  contact1: (row) => row.contact1,
  contact2: (row) => row.contact2,
  relativeName: (row) => row.relativeName,
  relation: (row) => row.relation,
  presence: (row) => row.presence,
  familyLabel: (row) => row.familyLabel,
  notes: (row) => row.notes,
}

const SCOPES: Array<{ value: TenantScope; label: string }> = [
  { value: 'with', label: 'Landlords with tenants' },
  { value: 'without', label: 'Landlords with 0 tenants' },
  { value: 'unlinked', label: 'Unlinked voters' },
]

const KINDS: Array<{ value: LandlordKind; label: string }> = [
  { value: 'all', label: 'All landlords' },
  { value: 'on_roll', label: 'On-roll' },
  { value: 'off_roll', label: 'Off-roll' },
]

const PRESENCE_FILTER_OPTIONS: Array<{ value: PresenceStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All presence' },
  ...PRESENCE_OPTIONS,
]

function buildTenantReportRows(groups: LandlordGroup[], photoUrls: Record<string, string>): TenantReportRow[] {
  const rows: TenantReportRow[] = []
  let sr = 0
  for (const group of groups) {
    const groupKey = tenantGroupHeading(group)
    for (const tenant of group.tenants) {
      sr += 1
      const photoPath = tenant.photo_url ?? ''
      rows.push({
        groupKey,
        srNo: String(sr),
        photo: photoPath ? (photoUrls[photoPath] ?? '') : '',
        photoPath,
        tenantName: tenant.name || '',
        tenantEpic: tenant.epic_no || '',
        room: tenant.room_no || '',
        houseNo: group.houseNo ?? '',
        landlordName: group.landlord.display_name || '',
        landlordEpic: landlordEpic(group.landlord) ?? 'Off-roll',
        ward: tenant.ward_no != null ? String(tenant.ward_no) : '',
        part: tenant.part_no != null ? String(tenant.part_no) : '',
        section: tenant.section != null ? String(tenant.section) : '',
        sectionName: tenant.section_name ?? '',
        age: tenant.age != null ? String(tenant.age) : '',
        gender: tenant.gender ?? '',
        contact1: tenant.contact_no_1 ?? '',
        contact2: tenant.contact_no_2 ?? '',
        relativeName: tenant.relative_name ?? '',
        relation: tenant.relative_relation ?? '',
        presence: presenceLabel(tenant.presence_status) ?? '',
        familyLabel: tenant.family_label ?? '',
        notes: tenant.notes ?? '',
      })
    }
  }
  return rows
}

async function signTenantPhotoUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(paths.filter(Boolean)))
  const resolved: Record<string, string> = {}
  for (let i = 0; i < unique.length; i += 80) {
    const batch = unique.slice(i, i + 80)
    const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
    if (!data) continue
    for (let j = 0; j < batch.length; j++) {
      const url = data[j]?.signedUrl
      if (url) resolved[batch[j]] = url
    }
  }
  return resolved
}

function Avatar({ name, photoUrl, size = 'md' }: { name: string; photoUrl?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'h-9 w-9 text-[11px]' : 'h-11 w-11 text-xs'
  if (photoUrl) {
    return <img src={photoUrl} alt={name} className={`${dim} flex-shrink-0 rounded-full border border-line object-cover`} />
  }
  return (
    <span className={`${dim} inline-flex flex-shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700`}>
      {initials(name)}
    </span>
  )
}

function OffRollBadge() {
  return (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-amber-700">
      Off-roll
    </span>
  )
}

function FilterSelect({ label, value, onChange, children }: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className="flex min-w-[8.5rem] flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
      {label}
      <select
        className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold normal-case tracking-normal text-ink-secondary outline-none focus:border-brand-300"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  )
}

function LandlordCard({
  group,
  collapsed,
  onToggle,
  photoUrls,
  canEdit,
  onOpenVoter,
  onAddTenant,
  onMoveTenant,
  onRemoveTenant,
  onEditLandlord,
  onClaimLandlord,
}: {
  group: LandlordGroup
  collapsed: boolean
  onToggle: () => void
  photoUrls: Record<string, string>
  canEdit: boolean
  onOpenVoter: (voter: Voter) => void
  onAddTenant: () => void
  onMoveTenant: (tenant: TenantVoter, landlordId: string) => void
  onRemoveTenant: (tenant: TenantVoter) => void
  onEditLandlord: () => void
  onClaimLandlord: () => void
}) {
  const landlord = group.landlord
  const voter = landlord.voter
  const offRoll = landlordIsOffRoll(landlord)
  const epic = landlordEpic(landlord)
  const ward = landlordWard(landlord)
  const part = landlordPart(landlord)
  const section = landlordSection(landlord)
  const landlordPhoto = voter?.photo_url ? photoUrls[voter.photo_url] : undefined
  const count = group.tenants.length

  return (
    <article className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <button type="button" onClick={count ? onToggle : undefined} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Avatar name={landlord.display_name} photoUrl={landlordPhoto} />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 truncate text-sm font-semibold text-ink">
              {landlord.display_name}
              {offRoll ? <OffRollBadge /> : null}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-tertiary">
              {epic ? <span className="font-mono">{epic}</span> : <span>No EPIC</span>}
              <span>House {group.houseNo ?? '—'}</span>
              <span>Part {part ?? '—'}</span>
              <span>Section {section ?? '—'}</span>
              {ward != null ? <span>Ward {ward}</span> : null}
            </p>
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
            {count} tenant{count === 1 ? '' : 's'}
          </span>
          {voter ? (
            <button
              type="button"
              onClick={() => onOpenVoter(voter)}
              className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              View
            </button>
          ) : null}
          {canEdit && offRoll ? (
            <button
              type="button"
              onClick={onClaimLandlord}
              className="inline-flex h-8 items-center rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              Claim
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={onEditLandlord}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-tertiary transition hover:bg-muted"
              aria-label="Edit landlord"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={onAddTenant}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" /> Add tenant
            </button>
          ) : null}
          {count ? (
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-tertiary transition hover:bg-muted"
              aria-label={collapsed ? 'Expand tenants' : 'Collapse tenants'}
            >
              {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
      </div>

      {count === 0 ? (
        <p className="px-4 py-3 text-xs text-ink-tertiary">No tenants yet.</p>
      ) : collapsed ? null : (
        <div className="divide-y divide-line">
          {group.tenants.map((tenant) => {
            const tenantPhoto = tenant.photo_url ? photoUrls[tenant.photo_url] : undefined
            return (
              <div key={tenant.linkId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <button type="button" onClick={() => onOpenVoter(tenant)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <Avatar name={tenant.name} photoUrl={tenantPhoto} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{tenant.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-tertiary">
                      <span className="font-mono">{tenant.epic_no}</span>
                      <span>Room {tenant.room_no ?? '—'}</span>
                      <span>{tenant.contact_no_1 || tenant.contact_no_2 || 'No contact'}</span>
                      <span>{presenceLabel(tenant.presence_status) ?? 'Presence not set'}</span>
                      <span>{[tenant.age, tenant.gender].filter(Boolean).join(' · ') || '—'}</span>
                    </p>
                  </div>
                </button>
                {canEdit ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onMoveTenant(tenant, landlord.id)}
                      className="inline-flex h-7 items-center rounded-md border border-line px-2 text-[11px] font-semibold text-ink-secondary transition hover:bg-muted"
                    >
                      Move
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveTenant(tenant)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--danger-border)] px-2 text-[11px] font-semibold text-[var(--danger)] transition hover:bg-[var(--danger-fill)]"
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </article>
  )
}

function VoterCandidateCard({
  voter,
  photoUrl,
  canEdit,
  onOpenVoter,
  onMakeLandlord,
  onAssignLandlord,
}: {
  voter: Voter
  photoUrl?: string
  canEdit: boolean
  onOpenVoter: () => void
  onMakeLandlord: () => void
  onAssignLandlord: () => void
}) {
  return (
    <article className="rounded-xl border border-line bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onOpenVoter} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Avatar name={voter.name} photoUrl={photoUrl} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{voter.name}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-tertiary">
              <span className="font-mono">{voter.epic_no}</span>
              <span>House {voter.house_no || '—'}</span>
              <span>Part {voter.part_no ?? '—'}</span>
              <span>Section {voter.section ?? '—'}</span>
              {voter.ward_no != null ? <span>Ward {voter.ward_no}</span> : null}
            </p>
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold text-ink-tertiary">Unlinked</span>
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={onMakeLandlord}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
              >
                <Home className="h-3.5 w-3.5" /> Make landlord
              </button>
              <button
                type="button"
                onClick={onAssignLandlord}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-2.5 text-xs font-semibold text-white transition hover:bg-brand-700"
              >
                <UserPlus className="h-3.5 w-3.5" /> Assign to landlord
              </button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  )
}

function AddTenantModal({
  target,
  onClose,
  onSaved,
}: {
  target: Landlord | null
  onClose: () => void
  onSaved: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Voter[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [roomNo, setRoomNo] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!target) return
    setQuery('')
    setResults([])
    setSelected(new Set())
    setRoomNo('')
    setNotes('')
  }, [target])

  useEffect(() => {
    if (!target || !query.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSelected(new Set())
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true)
        try {
          const rows = await searchAssignableVoters(target.id, query)
          if (!cancelled) setResults(rows)
        } catch (error) {
          if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not search voters.')
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, target])

  if (!target) return null

  const toggle = (epic: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(epic)) next.delete(epic)
      else next.add(epic)
      return next
    })
  }

  const submit = async () => {
    if (!selected.size) {
      toast.error('Select at least one voter.')
      return
    }
    const chosen = results.filter((voter) => selected.has(voter.epic_no))
    if (!chosen.length) {
      toast.error('Select at least one voter.')
      return
    }
    setSaving(true)
    let linked = 0
    try {
      for (const voter of chosen) {
        await assignTenant({
          landlordId: target.id,
          tenantEpic: voter.epic_no,
          roomNo: chosen.length === 1 ? roomNo : null,
          notes: chosen.length === 1 ? notes : null,
        })
        linked += 1
      }
      toast.success(`Added ${linked} tenant${linked === 1 ? '' : 's'}.`)
      onSaved()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add tenant.')
      if (linked) onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-ink">Add tenant</h3>
          <p className="mt-1 text-xs text-ink-tertiary">
            Search an active voter to link as a tenant of {target.display_name}
            {target.house_no ? ` (house ${target.house_no})` : ''}.
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="space-y-3 px-5 py-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
          <input
            autoFocus
            className="h-10 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
            placeholder="Search tenant by name / EPIC / house"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {searching ? (
          <div className="flex items-center py-4 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Searching voters...
          </div>
        ) : !query.trim() ? (
          <p className="py-2 text-sm text-ink-tertiary">Type a name, EPIC, or house number.</p>
        ) : results.length === 0 ? (
          <p className="py-2 text-sm text-ink-tertiary">No eligible voters match that search.</p>
        ) : (
          <div className="max-h-[45vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {results.map((voter) => (
              <label key={voter.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-line text-brand-600"
                  checked={selected.has(voter.epic_no)}
                  onChange={() => toggle(voter.epic_no)}
                  aria-label={`Select ${voter.name}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{voter.name}</p>
                  <p className="text-[11px] text-ink-tertiary">
                    <span className="font-mono">{voter.epic_no}</span> · House {voter.house_no || '—'} · Part {voter.part_no ?? '—'}
                  </p>
                </div>
              </label>
            ))}
          </div>
        )}

        {selected.size === 1 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="h-9 rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-300"
              placeholder="Room no (optional)"
              value={roomNo}
              onChange={(event) => setRoomNo(event.target.value)}
            />
            <input
              className="h-9 rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-300"
              placeholder="Notes (optional)"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        ) : selected.size > 1 ? (
          <p className="text-[11px] text-ink-tertiary">Room and notes apply to a single tenant. Bulk adds link without them.</p>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void submit()} loading={saving} disabled={!selected.size}>
          <Plus className="h-4 w-4" /> Add {selected.size > 1 ? `${selected.size} tenants` : 'tenant'}
        </Button>
      </div>
    </Dialog>
  )
}

function AssignLandlordModal({
  voter,
  onClose,
  onSaved,
}: {
  voter: Voter | null
  onClose: () => void
  onSaved: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Landlord[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setQuery('')
    setResults([])
  }, [voter?.id])

  useEffect(() => {
    if (!voter || !query.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true)
        try {
          const rows = await searchLandlordCandidates(query, voter.epic_no)
          if (!cancelled) setResults(rows)
        } catch (error) {
          if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not search landlords.')
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, voter])

  if (!voter) return null

  const assign = async (landlord: Landlord) => {
    setSaving(true)
    try {
      await assignTenant({ landlordId: landlord.id, tenantEpic: voter.epic_no })
      toast.success(`${voter.name} assigned to ${landlord.display_name}.`)
      onSaved()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not assign tenant.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-ink">Assign to landlord</h3>
          <p className="mt-1 text-xs text-ink-tertiary">
            Search a landlord to link {voter.name} as a tenant. Off-roll landlords appear here too.
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="space-y-3 px-5 py-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
          <input
            autoFocus
            className="h-10 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
            placeholder="Search landlord by name / EPIC / house"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {searching ? (
          <div className="flex items-center py-4 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Searching landlords...
          </div>
        ) : !query.trim() ? (
          <p className="py-2 text-sm text-ink-tertiary">Type a name, EPIC, or house number.</p>
        ) : results.length === 0 ? (
          <p className="py-2 text-sm text-ink-tertiary">No eligible landlords match that search.</p>
        ) : (
          <div className="max-h-[45vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {results.map((landlord) => (
              <div key={landlord.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-ink">
                    {landlord.display_name}
                    {landlordIsOffRoll(landlord) ? <OffRollBadge /> : null}
                  </p>
                  <p className="text-[11px] text-ink-tertiary">
                    {landlordEpic(landlord) ? <span className="font-mono">{landlordEpic(landlord)}</span> : 'No EPIC'}
                    {' · '}House {landlordHouseNo(landlord) || '—'}
                    {' · '}{landlord.tenant_count ?? 0} tenant{(landlord.tenant_count ?? 0) === 1 ? '' : 's'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void assign(landlord)}
                  className="inline-flex h-8 items-center rounded-lg bg-brand-600 px-2.5 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  Assign
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  )
}

function MoveTenantModal({
  target,
  onClose,
  onSaved,
}: {
  target: { tenant: TenantVoter; landlordId: string } | null
  onClose: () => void
  onSaved: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Landlord[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const tenant = target?.tenant ?? null
  const currentLandlordId = target?.landlordId ?? ''

  useEffect(() => {
    setQuery('')
    setResults([])
  }, [tenant?.linkId])

  useEffect(() => {
    if (!tenant || !query.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true)
        try {
          const rows = await searchLandlordCandidates(query, tenant.epic_no, currentLandlordId)
          if (!cancelled) setResults(rows.filter((landlord) => landlord.id !== currentLandlordId))
        } catch (error) {
          if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not search landlords.')
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, tenant, currentLandlordId])

  if (!tenant) return null

  const move = async (landlord: Landlord) => {
    setSaving(true)
    try {
      await moveTenant(tenant.linkId, landlord.id)
      toast.success(`${tenant.name} moved to ${landlord.display_name}.`)
      onSaved()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not move tenant.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-ink">Move tenant</h3>
          <p className="mt-1 text-xs text-ink-tertiary">Search a landlord to move {tenant.name} into that house.</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="space-y-3 px-5 py-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
          <input
            autoFocus
            className="h-10 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
            placeholder="Search landlord by name / EPIC / house"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {searching ? (
          <div className="flex items-center py-4 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Searching landlords...
          </div>
        ) : !query.trim() ? (
          <p className="py-2 text-sm text-ink-tertiary">Type a name, EPIC, or house number.</p>
        ) : results.length === 0 ? (
          <p className="py-2 text-sm text-ink-tertiary">No eligible landlords match that search.</p>
        ) : (
          <div className="max-h-[45vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {results.map((landlord) => (
              <div key={landlord.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-ink">
                    {landlord.display_name}
                    {landlordIsOffRoll(landlord) ? <OffRollBadge /> : null}
                  </p>
                  <p className="text-[11px] text-ink-tertiary">
                    {landlordEpic(landlord) ? <span className="font-mono">{landlordEpic(landlord)}</span> : 'No EPIC'}
                    {' · '}House {landlordHouseNo(landlord) || '—'}
                    {' · '}{landlord.tenant_count ?? 0} tenant{(landlord.tenant_count ?? 0) === 1 ? '' : 's'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void move(landlord)}
                  className="inline-flex h-8 items-center rounded-lg bg-brand-600 px-2.5 text-xs font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  Move here
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  )
}

function LandlordFormModal({
  open,
  mode,
  initialKind,
  landlord,
  tenantCount,
  preselectedVoter,
  wardScoped,
  onClose,
  onSaved,
}: {
  open: boolean
  mode: 'create' | 'edit'
  initialKind: 'on_roll' | 'off_roll'
  landlord: Landlord | null
  tenantCount: number
  preselectedVoter: Voter | null
  wardScoped: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [kind, setKind] = useState<'on_roll' | 'off_roll'>(initialKind)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Voter[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [houseNo, setHouseNo] = useState('')
  const [contact, setContact] = useState('')
  const [wardNo, setWardNo] = useState('')
  const [partNo, setPartNo] = useState('')
  const [section, setSection] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setSearching(false)
    setConfirmDelete(false)
    if (mode === 'edit' && landlord) {
      setKind(landlord.voter_id ? 'on_roll' : 'off_roll')
      setDisplayName(landlord.display_name)
      setHouseNo(landlord.house_no ?? '')
      setContact(landlord.contact ?? '')
      setWardNo(landlord.ward_no != null ? String(landlord.ward_no) : '')
      setPartNo(landlord.part_no != null ? String(landlord.part_no) : '')
      setSection(landlord.section != null ? String(landlord.section) : '')
      setNotes(landlord.notes ?? '')
      setSelectedVoter(landlord.voter)
      return
    }
    setKind(initialKind)
    setDisplayName(preselectedVoter?.name ?? '')
    setHouseNo(preselectedVoter?.house_no ?? '')
    setContact(preselectedVoter?.contact_no_1 ?? '')
    setWardNo(preselectedVoter?.ward_no != null ? String(preselectedVoter.ward_no) : '')
    setPartNo(preselectedVoter?.part_no != null ? String(preselectedVoter.part_no) : '')
    setSection(preselectedVoter?.section != null ? String(preselectedVoter.section) : '')
    setNotes('')
    setSelectedVoter(preselectedVoter)
  }, [open, mode, landlord, initialKind, preselectedVoter])

  useEffect(() => {
    if (!open || mode !== 'create' || kind !== 'on_roll' || !query.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true)
        try {
          const rows = await searchVoterCandidates(query)
          if (!cancelled) setResults(rows)
        } catch (error) {
          if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not search voters.')
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, mode, kind, query])

  if (!open) return null

  const changeKind = (next: 'on_roll' | 'off_roll') => {
    if (mode === 'edit' || next === kind) return
    setKind(next)
    setSelectedVoter(null)
    setQuery('')
    setResults([])
    if (next === 'off_roll') {
      setDisplayName('')
      setHouseNo('')
      setContact('')
      setWardNo('')
      setPartNo('')
      setSection('')
    }
  }

  const chooseVoter = (voter: Voter) => {
    setSelectedVoter(voter)
    setDisplayName(voter.name)
    setHouseNo(voter.house_no ?? '')
    setContact(voter.contact_no_1 ?? '')
    setWardNo(voter.ward_no != null ? String(voter.ward_no) : '')
    setPartNo(voter.part_no != null ? String(voter.part_no) : '')
    setSection(voter.section != null ? String(voter.section) : '')
  }

  const submit = async () => {
    const name = displayName.trim()
    if (!name) {
      toast.error('Landlord name is required.')
      return
    }
    if (mode === 'create' && kind === 'on_roll' && !selectedVoter) {
      toast.error('Select an active voter for this landlord.')
      return
    }
    if (kind === 'off_roll' && wardScoped && !wardNo.trim()) {
      toast.error('Ward is required for an off-roll landlord.')
      return
    }
    setSaving(true)
    try {
      if (mode === 'edit' && landlord) {
        await updateLandlord(landlord.id, {
          display_name: name,
          notes: notes.trim() || null,
          ...(kind === 'off_roll'
            ? {
                house_no: houseNo.trim() || null,
                contact: contact.trim() || null,
                ward_no: wardNo.trim() ? Number(wardNo) : null,
                part_no: partNo.trim() ? Number(partNo) : null,
                section: section.trim() ? Number(section) : null,
              }
            : {}),
        })
        toast.success('Landlord updated.')
      } else if (kind === 'on_roll' && selectedVoter) {
        await createLandlord({
          display_name: name,
          voter_id: selectedVoter.id,
          notes: notes.trim() || null,
        })
        toast.success('Landlord added.')
      } else {
        await createLandlord({
          display_name: name,
          house_no: houseNo.trim() || null,
          contact: contact.trim() || null,
          ward_no: wardNo.trim() ? Number(wardNo) : null,
          part_no: partNo.trim() ? Number(partNo) : null,
          section: section.trim() ? Number(section) : null,
          notes: notes.trim() || null,
        })
        toast.success('Off-roll landlord added.')
      }
      onSaved()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save landlord.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!landlord) return
    setDeleting(true)
    try {
      await deleteLandlord(landlord.id)
      toast.success('Landlord deleted.')
      onSaved()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete landlord.')
    } finally {
      setDeleting(false)
    }
  }

  const selectedSummary = selectedVoter ? (
    <div className="rounded-lg border border-line bg-muted/50 px-3 py-2">
      <p className="text-sm font-semibold text-ink">{selectedVoter.name}</p>
      <p className="mt-0.5 text-[11px] text-ink-tertiary">
        <span className="font-mono">{selectedVoter.epic_no}</span>
        {' · '}House {selectedVoter.house_no || '—'}
        {selectedVoter.ward_no != null ? ` · Ward ${selectedVoter.ward_no}` : ''}
        {selectedVoter.part_no != null ? ` · Part ${selectedVoter.part_no}` : ''}
        {selectedVoter.section != null ? ` · Section ${selectedVoter.section}` : ''}
      </p>
    </div>
  ) : null

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-ink">{mode === 'edit' ? 'Edit landlord' : 'Add landlord'}</h3>
          <p className="mt-1 text-xs text-ink-tertiary">
            {mode === 'edit'
              ? 'Update the landlord record. Linking to a voter is available from the Claim action on an off-roll card.'
              : 'Link an active voter or create an off-roll landlord without a voter row.'}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
        {mode === 'create' ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => changeKind('on_roll')}
              className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold transition ${
                kind === 'on_roll'
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-line bg-white text-ink-secondary hover:bg-muted'
              }`}
            >
              On-roll voter
            </button>
            <button
              type="button"
              onClick={() => changeKind('off_roll')}
              className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold transition ${
                kind === 'off_roll'
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-line bg-white text-ink-secondary hover:bg-muted'
              }`}
            >
              Off-roll name
            </button>
          </div>
        ) : null}

        {kind === 'on_roll' ? (
          mode === 'create' ? (
            <div className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
                <input
                  autoFocus
                  className="h-10 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
                  placeholder="Search active voter by name / EPIC / house"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {searching ? (
                <div className="flex items-center py-2 text-sm text-ink-tertiary">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Searching voters...
                </div>
              ) : !query.trim() ? (
                <p className="text-sm text-ink-tertiary">Search for the house owner on the voter roll.</p>
              ) : results.length === 0 ? (
                <p className="text-sm text-ink-tertiary">No eligible voters match that search.</p>
              ) : (
                <div className="max-h-52 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                  {results.map((voter) => (
                    <button
                      key={voter.id}
                      type="button"
                      onClick={() => chooseVoter(voter)}
                      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-muted ${
                        selectedVoter?.id === voter.id ? 'bg-brand-50' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{voter.name}</p>
                        <p className="text-[11px] text-ink-tertiary">
                          <span className="font-mono">{voter.epic_no}</span> · House {voter.house_no || '—'} · Part {voter.part_no ?? '—'}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {selectedSummary}
            </div>
          ) : (
            selectedSummary
          )
        ) : null}

        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Landlord name *</span>
          <input
            className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-300"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="House owner name"
          />
        </label>

        {kind === 'off_roll' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">House no</span>
              <input
                className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-300"
                value={houseNo}
                onChange={(event) => setHouseNo(event.target.value)}
                placeholder="House number"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Contact</span>
              <input
                className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-300"
                value={contact}
                onChange={(event) => setContact(event.target.value)}
                placeholder="Phone number"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                Ward{wardScoped ? ' *' : ''}
              </span>
              <input
                type="number"
                min={1}
                className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-300"
                value={wardNo}
                onChange={(event) => setWardNo(event.target.value)}
                placeholder="Ward"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Part</span>
              <input
                type="number"
                min={1}
                className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-300"
                value={partNo}
                onChange={(event) => setPartNo(event.target.value)}
                placeholder="Part"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Section</span>
              <input
                type="number"
                min={1}
                className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-brand-300"
                value={section}
                onChange={(event) => setSection(event.target.value)}
                placeholder="Section"
              />
            </label>
          </div>
        ) : null}

        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Notes</span>
          <textarea
            className="mt-1 min-h-[72px] w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-300"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional notes"
          />
        </label>

        {mode === 'edit' && confirmDelete ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-fill)] px-3 py-2">
            <span className="text-xs font-semibold text-[var(--danger)]">Delete this landlord permanently?</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="compact" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="danger" size="compact" onClick={() => void remove()} loading={deleting}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        {mode === 'edit' ? (
          tenantCount === 0 ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={confirmDelete}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          ) : (
            <span className="mr-auto text-[11px] text-ink-tertiary">Move or remove tenants before deleting.</span>
          )
        ) : null}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void submit()} loading={saving}>
          {mode === 'edit' ? 'Save changes' : 'Add landlord'}
        </Button>
      </div>
    </Dialog>
  )
}

function ClaimLandlordModal({
  landlord,
  onClose,
  onSaved,
}: {
  landlord: Landlord | null
  onClose: () => void
  onSaved: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Voter[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Voter | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setQuery('')
    setResults([])
    setSelected(null)
  }, [landlord?.id])

  useEffect(() => {
    if (!landlord || !query.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSelected(null)
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true)
        try {
          const rows = await searchVoterCandidates(query)
          if (!cancelled) setResults(rows)
        } catch (error) {
          if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not search voters.')
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, landlord])

  if (!landlord) return null

  const claim = async () => {
    if (!selected) return
    setSaving(true)
    try {
      await updateLandlord(landlord.id, { voter_id: selected.id })
      toast.success(`${landlord.display_name} linked to ${selected.name}. Tenants stay under this card.`)
      onSaved()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not link this landlord.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-ink">Claim off-roll landlord</h3>
          <p className="mt-1 text-xs text-ink-tertiary">
            Link {landlord.display_name} to an active voter. Existing tenants remain under this landlord.
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="space-y-3 px-5 py-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
          <input
            autoFocus
            className="h-10 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
            placeholder="Search voter by name / EPIC / house"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {searching ? (
          <div className="flex items-center py-4 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Searching voters...
          </div>
        ) : !query.trim() ? (
          <p className="py-2 text-sm text-ink-tertiary">Only active voters who are not tenants or landlords appear here.</p>
        ) : results.length === 0 ? (
          <p className="py-2 text-sm text-ink-tertiary">No eligible voters match that search.</p>
        ) : (
          <div className="max-h-[45vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {results.map((voter) => (
              <button
                key={voter.id}
                type="button"
                onClick={() => setSelected(voter)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-muted ${
                  selected?.id === voter.id ? 'bg-brand-50' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{voter.name}</p>
                  <p className="text-[11px] text-ink-tertiary">
                    <span className="font-mono">{voter.epic_no}</span> · House {voter.house_no || '—'} · Part {voter.part_no ?? '—'}
                    {voter.ward_no != null ? ` · Ward ${voter.ward_no}` : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void claim()} loading={saving} disabled={!selected}>
          Link voter
        </Button>
      </div>
    </Dialog>
  )
}

export function TenantsPage() {
  const { profile } = useAuth()
  const canEdit = profile?.role === 'admin' || profile?.role === 'sub-admin' || profile?.can_edit === true
  const wardScoped = profile != null && profile.role !== 'admin' && profile.role !== 'sub-admin'
  const isMobile = useIsMobile()

  const [scope, setScope] = usePersistentState<TenantScope>('vote:tenants:scope', 'with')
  const [kind, setKind] = usePersistentState<LandlordKind>('vote:tenants:kind', 'all')
  const [query, setQuery] = usePersistentState<string>('vote:tenants:q', '')
  const [wardFilter, setWardFilter] = usePersistentState<string>('vote:tenants:ward', 'all')
  const [partFilter, setPartFilter] = usePersistentState<string>('vote:tenants:part', 'all')
  const [sectionFilter, setSectionFilter] = usePersistentState<string>('vote:tenants:section', 'all')
  const [houseFilter, setHouseFilter] = usePersistentState<string>('vote:tenants:house', '')
  const [presence, setPresence] = usePersistentState<PresenceStatus | 'all'>('vote:tenants:presence', 'all')
  const [filtersOpen, setFiltersOpen] = useState(false)

  const [links, setLinks] = useState<TenantLinkRow[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [voters, setVoters] = useState<Voter[]>([])
  const [counts, setCounts] = useState<TenantCounts>({ landlords: 0, tenants: 0, unlinked: 0, onRoll: 0, offRoll: 0 })
  const [loading, setLoading] = useState(true)
  const [debouncedQuery, setDebouncedQuery] = useState(query)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)

  const [addTenantTarget, setAddTenantTarget] = useState<Landlord | null>(null)
  const [assignLandlordTarget, setAssignLandlordTarget] = useState<Voter | null>(null)
  const [moveTarget, setMoveTarget] = useState<{ tenant: TenantVoter; landlordId: string } | null>(null)
  const [removeTarget, setRemoveTarget] = useState<TenantVoter | null>(null)
  const [removing, setRemoving] = useState(false)
  const [landlordForm, setLandlordForm] = useState<{
    mode: 'create' | 'edit'
    kind: 'on_roll' | 'off_roll'
    landlord: Landlord | null
    tenantCount: number
    preselectedVoter: Voter | null
  } | null>(null)
  const [claimTarget, setClaimTarget] = useState<Landlord | null>(null)

  const [reportFields, setReportFields] = usePersistentState<ReportFieldItem[]>('vote:tenants:printFields', DEFAULT_TENANT_REPORT_FIELDS)
  const [reportFontSize, setReportFontSize] = usePersistentState<number>('vote:tenants:printFontSize', DEFAULT_PRINT_STYLE.fontSize)
  const [reportBold, setReportBold] = usePersistentState<boolean>('vote:tenants:printBold', false)
  const [reportIncludePhotos, setReportIncludePhotos] = usePersistentState<boolean>('vote:tenants:includePhotos', false)
  const [reportGrouped, setReportGrouped] = usePersistentState<boolean>('vote:tenants:printGrouped', true)
  const [printOpen, setPrintOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const base: LandlordFilterParams & TenantFilterParams = {
        q: debouncedQuery.trim() || undefined,
        ward_no: wardFilter === 'all' ? undefined : wardFilter,
        part_no: partFilter === 'all' ? undefined : partFilter,
        section: sectionFilter === 'all' ? undefined : sectionFilter,
        house_no: houseFilter.trim() || undefined,
        kind,
      }
      if (scope === 'without') {
        const response = await fetchLandlords({ ...base, has_tenants: 'without' })
        setLandlords(response.landlords)
        setLinks([])
        setVoters([])
        setCounts(response.counts)
      } else {
        const response = await fetchTenantList({ ...base, ...(scope === 'unlinked' ? { unlinked: true } : {}) })
        setLinks(response.links)
        setVoters(response.voters)
        setLandlords([])
        setCounts(response.counts)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load tenants.')
    } finally {
      setLoading(false)
    }
  }, [debouncedQuery, houseFilter, kind, partFilter, scope, sectionFilter, wardFilter])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => groupTenantLinks(links), [links])
  const visibleGroups = useMemo(() => {
    if (presence === 'all') return groups
    return groups
      .map((group) => ({ ...group, tenants: group.tenants.filter((tenant) => tenant.presence_status === presence) }))
      .filter((group) => group.tenants.length > 0)
  }, [groups, presence])

  const visibleVoters = useMemo(
    () => (presence === 'all' ? voters : voters.filter((voter) => voter.presence_status === presence)),
    [presence, voters],
  )

  const tenantRowCount = useMemo(
    () => visibleGroups.reduce((sum, group) => sum + group.tenants.length, 0),
    [visibleGroups],
  )

  const photoPaths = useMemo(() => {
    const paths: string[] = []
    for (const group of groups) {
      if (group.landlord.voter?.photo_url) paths.push(group.landlord.voter.photo_url)
      for (const tenant of group.tenants) if (tenant.photo_url) paths.push(tenant.photo_url)
    }
    for (const landlord of landlords) if (landlord.voter?.photo_url) paths.push(landlord.voter.photo_url)
    for (const voter of voters) if (voter.photo_url) paths.push(voter.photo_url)
    return Array.from(new Set(paths))
  }, [groups, landlords, voters])
  const photoUrls = usePhotoUrls(photoPaths)

  const wardOptions = useMemo(() => {
    const set = new Set<number>()
    for (const ward of profile?.allowed_wards ?? []) set.add(ward)
    for (const group of groups) {
      const ward = landlordWard(group.landlord)
      if (ward != null) set.add(ward)
      for (const tenant of group.tenants) if (tenant.ward_no != null) set.add(tenant.ward_no)
    }
    for (const landlord of landlords) {
      const ward = landlordWard(landlord)
      if (ward != null) set.add(ward)
    }
    for (const voter of voters) if (voter.ward_no != null) set.add(voter.ward_no)
    return Array.from(set).sort((a, b) => a - b)
  }, [groups, landlords, profile?.allowed_wards, voters])

  const partOptions = useMemo(() => {
    const set = new Set<number>()
    for (const group of groups) {
      const part = landlordPart(group.landlord)
      if (part != null) set.add(part)
      for (const tenant of group.tenants) if (tenant.part_no != null) set.add(tenant.part_no)
    }
    for (const landlord of landlords) {
      const part = landlordPart(landlord)
      if (part != null) set.add(part)
    }
    for (const voter of voters) if (voter.part_no != null) set.add(voter.part_no)
    return Array.from(set).sort((a, b) => a - b)
  }, [groups, landlords, voters])

  const sectionOptions = useMemo(() => {
    const set = new Set<number>()
    for (const group of groups) {
      const section = landlordSection(group.landlord)
      if (section != null) set.add(section)
      for (const tenant of group.tenants) if (tenant.section != null) set.add(tenant.section)
    }
    for (const landlord of landlords) {
      const section = landlordSection(landlord)
      if (section != null) set.add(section)
    }
    for (const voter of voters) if (voter.section != null) set.add(voter.section)
    return Array.from(set).sort((a, b) => a - b)
  }, [groups, landlords, voters])

  const activeFilterCount =
    (wardFilter !== 'all' ? 1 : 0) +
    (partFilter !== 'all' ? 1 : 0) +
    (sectionFilter !== 'all' ? 1 : 0) +
    (houseFilter.trim() ? 1 : 0) +
    (presence !== 'all' ? 1 : 0) +
    (kind !== 'all' && scope !== 'unlinked' ? 1 : 0)

  const clearFilters = () => {
    setWardFilter('all')
    setPartFilter('all')
    setSectionFilter('all')
    setHouseFilter('')
    setPresence('all')
    setKind('all')
  }

  const toggleGroup = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const canEditLocal = canEdit

  const openEditLandlord = (landlord: Landlord, tenantCount: number) => {
    setLandlordForm({
      mode: 'edit',
      kind: landlordIsOffRoll(landlord) ? 'off_roll' : 'on_roll',
      landlord,
      tenantCount,
      preselectedVoter: null,
    })
  }

  const confirmRemove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      await removeTenantLink(removeTarget.linkId)
      toast.success(`${removeTarget.name} removed from this landlord.`)
      setRemoveTarget(null)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove tenant.')
    } finally {
      setRemoving(false)
    }
  }

  const filterSummary = [
    debouncedQuery.trim() ? `Search: ${debouncedQuery.trim()}` : '',
    wardFilter !== 'all' ? `Ward ${wardFilter}` : '',
    partFilter !== 'all' ? `Part ${partFilter}` : '',
    sectionFilter !== 'all' ? `Section ${sectionFilter}` : '',
    houseFilter.trim() ? `House ${houseFilter.trim()}` : '',
    presence !== 'all' ? `Presence: ${presenceLabel(presence) ?? presence}` : '',
    kind !== 'all' && scope !== 'unlinked' ? `Kind: ${kind === 'on_roll' ? 'On-roll' : 'Off-roll'}` : '',
  ].filter(Boolean).join(' · ')

  const reportMeta = [
    filterSummary,
    `${visibleGroups.length} landlords`,
    `${tenantRowCount} tenants`,
  ].filter(Boolean).join(' · ')

  const enabledReportFields = (items: ReportFieldItem[]): ReportFieldDef<TenantReportRow>[] =>
    items.filter((item) => item.enabled).map((item) => ({
      key: item.key,
      label: TENANT_REPORT_FIELD_DEFS.find((def) => def.key === item.key)?.label ?? item.key,
      getValue: TENANT_REPORT_GETTERS[item.key] ?? ((row) => (row as unknown as Record<string, string>)[item.key] ?? ''),
    }))

  const closeReports = () => {
    setPrintOpen(false)
    setExportOpen(false)
  }

  const rememberReportOptions = (fields: ReportFieldItem[], grouped: boolean, style: PrintStyleOptions) => {
    setReportFields(fields)
    setReportGrouped(grouped)
    setReportFontSize(style.fontSize)
    setReportBold(style.boldText)
  }

  const buildRowsWithPhotos = async (fields: ReportFieldItem[], wantPhotos = true) => {
    const includePhotos = wantPhotos && fields.some((item) => item.key === 'photo' && item.enabled)
    const draft = buildTenantReportRows(visibleGroups, photoUrls)
    if (!includePhotos) return { rows: draft, includePhotos }
    const signed = await signTenantPhotoUrls(draft.map((row) => row.photoPath))
    return {
      rows: buildTenantReportRows(visibleGroups, { ...photoUrls, ...signed }),
      includePhotos,
    }
  }

  const handlePrintConfirm = (fields: ReportFieldItem[], grouped: boolean, style: PrintStyleOptions) => {
    rememberReportOptions(fields, grouped, style)
    closeReports()
    if (!tenantRowCount) {
      toast.error('No tenants to print.')
      return
    }
    void (async () => {
      const { rows } = await buildRowsWithPhotos(fields)
      handlePrint({
        rows,
        fields: enabledReportFields(fields),
        title: 'Tenants',
        meta: `${reportMeta} · ${new Date().toLocaleString()}`,
        groupBy: grouped ? { groupBy: 'landlord', resolve: (row) => row.groupKey } : undefined,
      }, { ...style, keepGroupTogether: grouped })
    })()
  }

  const handlePdfDownload = (fields: ReportFieldItem[], grouped: boolean, style: PrintStyleOptions) => {
    rememberReportOptions(fields, grouped, style)
    closeReports()
    if (!tenantRowCount) {
      toast.error('No tenants to download.')
      return
    }
    void (async () => {
      const { rows } = await buildRowsWithPhotos(fields)
      const enabled = enabledReportFields(fields)
      const pdfRows: string[][] = []
      if (grouped) {
        const byGroup = new Map<string, TenantReportRow[]>()
        for (const row of rows) {
          const list = byGroup.get(row.groupKey)
          if (list) list.push(row)
          else byGroup.set(row.groupKey, [row])
        }
        const labelIndex = enabled.findIndex((field) => field.key !== 'photo')
        for (const [groupKey, groupRows] of byGroup.entries()) {
          const headerRow = enabled.map(() => '')
          if (labelIndex >= 0) headerRow[labelIndex] = groupKey
          pdfRows.push(headerRow)
          for (const row of groupRows) pdfRows.push(enabled.map((field) => field.getValue(row)))
        }
      } else {
        for (const row of rows) pdfRows.push(enabled.map((field) => field.getValue(row)))
      }
      await downloadPdfTable({
        title: 'Tenants',
        summary: [
          ['Landlords', String(visibleGroups.length)],
          ['Tenants', String(rows.length)],
          ['Filters', filterSummary || 'All'],
          ['Generated', new Date().toLocaleString()],
        ],
        headers: enabled.map((field) => field.label),
        rows: pdfRows,
        fieldKeys: enabled.map((field) => field.key),
        fontSize: style.fontSize,
        boldText: style.boldText,
        fileName: `tenants-${new Date().toISOString().slice(0, 10)}.pdf`,
      })
      toast.success('PDF downloaded.')
    })()
  }

  const handleExportConfirm = (fields: ReportFieldItem[], grouped: boolean, style: PrintStyleOptions) => {
    rememberReportOptions(fields, grouped, style)
    setReportIncludePhotos(style.includePhotos ?? false)
    closeReports()
    if (!tenantRowCount) {
      toast.error('No tenants to export.')
      return
    }
    void (async () => {
      const { rows, includePhotos } = await buildRowsWithPhotos(fields, style.includePhotos === true)
      const exportFields = enabledReportFields(fields).map((field) => (
        field.key === 'photo' && !(includePhotos && style.includePhotos)
          ? { ...field, getValue: (row: TenantReportRow) => (row.photoPath ? 'Photo' : '') }
          : field
      ))
      await exportRowsToExcel({
        rows,
        fields: exportFields,
        fileName: 'tenants',
        title: 'Tenants',
        meta: `${reportMeta} · ${new Date().toLocaleString()}`,
        groupBy: grouped ? { groupBy: 'landlord', resolve: (row) => row.groupKey } : undefined,
        showMeta: true,
      }, { ...style, includePhotos: includePhotos && style.includePhotos })
    })()
  }

  const filtersPanel = (
    <div className="flex flex-wrap items-end gap-2">
      <FilterSelect label="Ward" value={wardFilter} onChange={setWardFilter}>
        <option value="all">All wards</option>
        {wardOptions.map((ward) => (
          <option key={ward} value={String(ward)}>Ward {ward}</option>
        ))}
      </FilterSelect>
      <FilterSelect label="Part" value={partFilter} onChange={setPartFilter}>
        <option value="all">All parts</option>
        {partOptions.map((part) => (
          <option key={part} value={String(part)}>Part {part}</option>
        ))}
      </FilterSelect>
      <FilterSelect label="Section" value={sectionFilter} onChange={setSectionFilter}>
        <option value="all">All sections</option>
        {sectionOptions.map((section) => (
          <option key={section} value={String(section)}>Section {section}</option>
        ))}
      </FilterSelect>
      <label className="flex min-w-[8.5rem] flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
        House no
        <input
          className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold normal-case tracking-normal text-ink-secondary outline-none focus:border-brand-300"
          placeholder="Any house"
          value={houseFilter}
          onChange={(event) => setHouseFilter(event.target.value)}
        />
      </label>
      {scope !== 'unlinked' ? (
        <FilterSelect label="Landlord kind" value={kind} onChange={(value) => setKind(value as LandlordKind)}>
          {KINDS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </FilterSelect>
      ) : null}
      <FilterSelect label="Tenant presence" value={presence} onChange={(value) => setPresence(value as PresenceStatus | 'all')}>
        {PRESENCE_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </FilterSelect>
      {activeFilterCount ? (
        <button
          type="button"
          onClick={clearFilters}
          className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink-secondary transition hover:bg-muted"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  )

  const stats = counts

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Tenants"
        description="Group tenants under the house owner. Owners can be on the roll or off-roll; only explicitly assigned tenants appear here."
        action={
          <div className="flex flex-wrap items-center gap-2">
            {canEditLocal ? (
              <Button onClick={() => setLandlordForm({ mode: 'create', kind: 'on_roll', landlord: null, tenantCount: 0, preselectedVoter: null })}>
                <Plus className="h-4 w-4" /> Add landlord
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setPrintOpen(true)} disabled={!tenantRowCount}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button variant="secondary" onClick={() => setExportOpen(true)} disabled={!tenantRowCount}>
              <Download className="h-4 w-4" /> Excel
            </Button>
          </div>
        }
      />

      <section className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-white px-3 py-3 sm:grid-cols-5 sm:gap-3 sm:px-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Landlords</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{stats.landlords.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">On-roll</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{stats.onRoll.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Off-roll</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{stats.offRoll.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Tenants</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{stats.tenants.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Unlinked voters</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{stats.unlinked.toLocaleString()}</p>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="space-y-3 border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
              <input
                className="h-9 w-full rounded-lg border border-line bg-white pl-8 pr-3 text-sm outline-none focus:border-brand-300"
                placeholder="Search landlord, tenant, EPIC, house, or room"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition ${
                filtersOpen || activeFilterCount
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-line bg-white text-ink-secondary hover:bg-muted'
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filters
              {activeFilterCount ? <span className="rounded-full bg-white/20 px-1.5">{activeFilterCount}</span> : null}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {SCOPES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setScope(option.value)}
                className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold transition ${
                  scope === option.value
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-line bg-white text-ink-secondary hover:bg-muted'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {isMobile ? (
            <MobileSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
              {filtersPanel}
            </MobileSheet>
          ) : filtersOpen ? (
            <div className="rounded-lg border border-line bg-muted/60 p-3">{filtersPanel}</div>
          ) : null}

          <p className="text-xs text-ink-tertiary">
            {scope === 'with'
              ? `${visibleGroups.length.toLocaleString()} landlords · ${tenantRowCount.toLocaleString()} tenants${filterSummary ? ` · ${filterSummary}` : ''}`
              : scope === 'without'
                ? `${landlords.length.toLocaleString()} landlords${filterSummary ? ` · ${filterSummary}` : ''}`
                : `${visibleVoters.length.toLocaleString()} voters${filterSummary ? ` · ${filterSummary}` : ''}`}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-ink-tertiary">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading tenants...
          </div>
        ) : scope === 'with' ? (
          visibleGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-ink-tertiary">
              <Users className="h-8 w-8" />
              <p className="text-sm">
                {filterSummary || query.trim()
                  ? 'No landlords or tenants match these filters.'
                  : 'No tenant links yet. Add a tenant from a landlord to start grouping a house.'}
              </p>
              {!filterSummary && !query.trim() && canEditLocal ? (
                <button
                  type="button"
                  onClick={() => { setScope('without'); setQuery('') }}
                  className="mt-1 inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white"
                >
                  Browse landlords with 0 tenants
                </button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3 p-3">
              {visibleGroups.map((group) => (
                <LandlordCard
                  key={group.landlord.id}
                  group={group}
                  collapsed={collapsed.has(group.landlord.id)}
                  onToggle={() => toggleGroup(group.landlord.id)}
                  photoUrls={photoUrls}
                  canEdit={canEditLocal}
                  onOpenVoter={setSelectedVoter}
                  onAddTenant={() => setAddTenantTarget(group.landlord)}
                  onMoveTenant={(tenant, landlordId) => setMoveTarget({ tenant, landlordId })}
                  onRemoveTenant={setRemoveTarget}
                  onEditLandlord={() => openEditLandlord(group.landlord, group.tenants.length)}
                  onClaimLandlord={() => setClaimTarget(group.landlord)}
                />
              ))}
            </div>
          )
        ) : scope === 'without' ? (
          landlords.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-ink-tertiary">
              <Home className="h-8 w-8" />
              <p className="text-sm">No landlords with 0 tenants match these filters.</p>
            </div>
          ) : (
            <div className="space-y-3 p-3">
              {landlords.map((landlord) => (
                <LandlordCard
                  key={landlord.id}
                  group={{ landlord, houseNo: landlordHouseNo(landlord), tenants: [] }}
                  collapsed={false}
                  onToggle={() => {}}
                  photoUrls={photoUrls}
                  canEdit={canEditLocal}
                  onOpenVoter={setSelectedVoter}
                  onAddTenant={() => setAddTenantTarget(landlord)}
                  onMoveTenant={() => {}}
                  onRemoveTenant={() => {}}
                  onEditLandlord={() => openEditLandlord(landlord, landlord.tenant_count ?? 0)}
                  onClaimLandlord={() => setClaimTarget(landlord)}
                />
              ))}
            </div>
          )
        ) : visibleVoters.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-ink-tertiary">
            <Home className="h-8 w-8" />
            <p className="text-sm">No unlinked voters match these filters.</p>
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {visibleVoters.map((voter) => (
              <VoterCandidateCard
                key={voter.id}
                voter={voter}
                photoUrl={voter.photo_url ? photoUrls[voter.photo_url] : undefined}
                canEdit={canEditLocal}
                onOpenVoter={() => setSelectedVoter(voter)}
                onMakeLandlord={() => setLandlordForm({
                  mode: 'create',
                  kind: 'on_roll',
                  landlord: null,
                  tenantCount: 0,
                  preselectedVoter: voter,
                })}
                onAssignLandlord={() => setAssignLandlordTarget(voter)}
              />
            ))}
          </div>
        )}
      </section>

      <AddTenantModal
        target={addTenantTarget}
        onClose={() => setAddTenantTarget(null)}
        onSaved={() => { void load() }}
      />

      <AssignLandlordModal
        voter={assignLandlordTarget}
        onClose={() => setAssignLandlordTarget(null)}
        onSaved={() => { void load() }}
      />

      <MoveTenantModal
        target={moveTarget}
        onClose={() => setMoveTarget(null)}
        onSaved={() => { void load() }}
      />

      <LandlordFormModal
        open={landlordForm != null}
        mode={landlordForm?.mode ?? 'create'}
        initialKind={landlordForm?.kind ?? 'on_roll'}
        landlord={landlordForm?.landlord ?? null}
        tenantCount={landlordForm?.tenantCount ?? 0}
        preselectedVoter={landlordForm?.preselectedVoter ?? null}
        wardScoped={wardScoped}
        onClose={() => setLandlordForm(null)}
        onSaved={() => { void load() }}
      />

      <ClaimLandlordModal
        landlord={claimTarget}
        onClose={() => setClaimTarget(null)}
        onSaved={() => { void load() }}
      />

      <Dialog open={removeTarget != null} onClose={() => setRemoveTarget(null)}>
        <div className="px-5 py-4">
          <h3 className="text-lg font-semibold text-ink">Remove tenant link</h3>
          <p className="mt-2 text-sm leading-6 text-ink-secondary">
            Remove <span className="font-semibold text-ink">{removeTarget?.name}</span> from this landlord? The voter
            record stays in the roll; only the tenant link is deleted.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="secondary" onClick={() => setRemoveTarget(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirmRemove()} loading={removing}>
            <Trash2 className="h-4 w-4" /> Remove link
          </Button>
        </div>
      </Dialog>

      {selectedVoter ? (
        <VoterDetailDrawer
          voter={selectedVoter}
          onClose={() => setSelectedVoter(null)}
          onSaved={load}
        />
      ) : null}

      <ReportConfigModal
        title="Tenants"
        open={printOpen}
        mode="print"
        fieldDefs={TENANT_REPORT_FIELD_DEFS}
        fields={reportFields}
        defaultFields={DEFAULT_TENANT_REPORT_FIELDS}
        showLayout
        layout={reportGrouped}
        layoutTrueLabel="Grouped by landlord"
        layoutFalseLabel="Flat list"
        fontSize={reportFontSize}
        boldText={reportBold}
        defaultFontSize={DEFAULT_PRINT_STYLE.fontSize}
        defaultBoldText={DEFAULT_PRINT_STYLE.boldText}
        printDescription="Print or download a PDF of tenants grouped by landlord."
        printActionLabel="Open print preview"
        onClose={() => setPrintOpen(false)}
        onConfirm={handlePrintConfirm}
        onDownloadPdf={handlePdfDownload}
      />

      <ReportConfigModal
        title="Tenants"
        open={exportOpen}
        mode="export"
        fieldDefs={TENANT_REPORT_FIELD_DEFS}
        fields={reportFields}
        defaultFields={DEFAULT_TENANT_REPORT_FIELDS}
        showLayout
        layout={reportGrouped}
        layoutTrueLabel="Grouped by landlord"
        layoutFalseLabel="Flat list"
        fontSize={reportFontSize}
        boldText={reportBold}
        defaultFontSize={DEFAULT_PRINT_STYLE.fontSize}
        defaultBoldText={DEFAULT_PRINT_STYLE.boldText}
        includePhotos={reportIncludePhotos}
        showIncludePhotos
        onClose={() => setExportOpen(false)}
        onConfirm={handleExportConfirm}
      />
    </div>
  )
}
