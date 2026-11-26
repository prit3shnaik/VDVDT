import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import toast from 'react-hot-toast'
import { Camera, ChevronDown, Clock, Copy, ImageUp, Pencil, Phone, Save, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { supabase } from '../../lib/supabase'
import { uploadPhoto } from '../../lib/photos'
import { useAuth } from '../../hooks/useAuth'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { ActivityLog, CustomField, Voter } from '../../lib/types'
import { VOTER_CATEGORY_OPTIONS, voterCategoryLabel } from '../../lib/voterCategory'
import { cn, formatDate } from '../../lib/utils'

type CustomFieldValueMap = Record<string, unknown>

interface CustomFieldValueRow {
  field_id: string
  value: unknown
}

interface CustomFieldStoredValue {
  value: unknown
  note?: unknown
}

const isStoredCustomValue = (value: unknown): value is CustomFieldStoredValue => {
  return Boolean(value) && typeof value === 'object' && 'value' in (value as Record<string, unknown>)
}

const getStoredFieldValue = (value: unknown) => {
  if (isStoredCustomValue(value)) {
    return value.value
  }

  return value
}

const getStoredFieldNote = (value: unknown) => {
  if (!isStoredCustomValue(value)) {
    return ''
  }

  const note = value.note
  if (note === null || note === undefined) {
    return ''
  }

  return String(note)
}

const withUpdatedFieldValue = (stored: unknown, nextValue: unknown): CustomFieldStoredValue | unknown => {
  if (!isStoredCustomValue(stored)) {
    return nextValue
  }

  return {
    ...stored,
    value: nextValue,
  }
}

const withUpdatedFieldNote = (stored: unknown, nextNote: string): CustomFieldStoredValue => {
  const base = isStoredCustomValue(stored) ? stored : { value: stored }
  return {
    ...base,
    note: nextNote,
  }
}

const parseFieldOptions = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item).trim())
          .filter(Boolean)
      }
    } catch {
      return value
        .split(/\r?\n|,/) 
        .map((item) => item.trim())
        .filter(Boolean)
    }
  }

  return []
}

const hasValueForField = (field: CustomField, value: unknown) => {
  const resolvedValue = getStoredFieldValue(value)

  if (field.allow_custom_note && String(getStoredFieldNote(value)).trim()) {
    return true
  }

  if (resolvedValue === null || resolvedValue === undefined) {
    return false
  }

  if (field.field_type === 'multiselect' || field.field_type === 'checkbox') {
    return Array.isArray(resolvedValue) ? resolvedValue.length > 0 : Boolean(String(resolvedValue).trim())
  }

  if (typeof resolvedValue === 'number') {
    return Number.isFinite(resolvedValue)
  }

  if (typeof resolvedValue === 'boolean') {
    return resolvedValue
  }

  return Boolean(String(resolvedValue).trim())
}

const normalizeFieldValue = (field: CustomField, value: unknown) => {
  const resolvedValue = getStoredFieldValue(value)
  const resolvedNote = String(getStoredFieldNote(value)).trim()

  let normalizedValue: unknown

  if (field.field_type === 'number') {
    const numeric = typeof resolvedValue === 'number' ? resolvedValue : Number(resolvedValue)
    normalizedValue = Number.isFinite(numeric) ? numeric : null
  } else if (field.field_type === 'multiselect' || field.field_type === 'checkbox') {
    const source = Array.isArray(resolvedValue) ? resolvedValue : [resolvedValue]
    const cleaned = Array.from(new Set(source.map((item) => String(item).trim()).filter(Boolean)))
    normalizedValue = cleaned.length ? cleaned : null
  } else if (field.field_type === 'dropdown' || field.field_type === 'radio' || field.field_type === 'date') {
    const text = String(resolvedValue).trim()
    normalizedValue = text ? text : null
  } else {
    const text = String(resolvedValue)
    const trimmed = text.trim()
    normalizedValue = trimmed ? trimmed : null
  }

  if (field.allow_custom_note) {
    if (normalizedValue === null && !resolvedNote) {
      return null
    }

    return {
      value: normalizedValue,
      note: resolvedNote || null,
    }
  }

  return normalizedValue
}

interface VoterDetailDrawerProps {
  voter: Voter | null
  onClose: () => void
  onSaved: () => Promise<void>
}

function SummaryRow({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">{label}</p>
      <p className="truncate text-sm text-ink">{String(value)}</p>
    </div>
  )
}

export function VoterDetailDrawer({ voter, onClose, onSaved }: VoterDetailDrawerProps) {
  const { profile } = useAuth()
  const isMobile = useIsMobile()
  const [draft, setDraft] = useState<Partial<Voter>>({})
  const [saving, setSaving] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [customValues, setCustomValues] = useState<CustomFieldValueMap>({})
  const [loadingCustomFields, setLoadingCustomFields] = useState(false)
  const [mobileEditing, setMobileEditing] = useState(false)
  const [mobileCustomOpen, setMobileCustomOpen] = useState(false)
  const [mobileLogsOpen, setMobileLogsOpen] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const canEditVoter = profile?.role === 'admin' || profile?.can_edit === true
  const canViewActivityLogs = profile?.role === 'admin' || profile?.role === 'sub-admin'

  useEffect(() => {
    if (!voter) {
      return
    }

    setDraft(voter)
    setMobileEditing(false)
    setMobileCustomOpen(false)
    setMobileLogsOpen(false)

    if (!canViewActivityLogs) {
      setLogs([])
      return
    }

    let cancelled = false

    supabase
      .from('activity_logs')
      .select('id,actor_user_id,action,target_table,target_id,details,ip,user_agent,created_at')
      .eq('target_table', 'voters')
      .eq('target_id', voter.id)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (cancelled) {
          return
        }

        if (error) {
          setLogs([])
          return
        }

        setLogs((data as ActivityLog[] | null) ?? [])
      })

    return () => {
      cancelled = true
    }
  }, [canViewActivityLogs, voter, voter?.id])

  useEffect(() => {
    let cancelled = false

    async function loadPhotoPreview(path: string) {
      const { data, error } = await supabase.storage.from('voter-photos').createSignedUrl(path, 60 * 60)
      if (cancelled || error || !data?.signedUrl) {
        return
      }
      setPhotoPreviewUrl(data.signedUrl)
    }

    const path = draft.photo_url ?? voter?.photo_url ?? null
    if (!path) {
      setPhotoPreviewUrl(null)
      return () => {
        cancelled = true
      }
    }

    void loadPhotoPreview(path)

    return () => {
      cancelled = true
    }
  }, [draft.photo_url, voter?.photo_url])

  useEffect(() => {
    if (!voter) {
      setCustomFields([])
      setCustomValues({})
      return
    }

    let cancelled = false
    setLoadingCustomFields(true)

    const fetchFields = async () => {
      const primary = await supabase
        .from('custom_fields')
        .select('id,name,label,field_type,options,required,show_in_card,allow_custom_note,position')
        .order('position', { ascending: true })

      if (primary.error?.code === '42703') {
        const fallback = await supabase
          .from('custom_fields')
          .select('id,name,label,field_type,options,required,show_in_card,position')
          .order('position', { ascending: true })

        if (fallback.error) {
          return { data: null, error: fallback.error }
        }

        const legacyFields = ((fallback.data as Omit<CustomField, 'allow_custom_note'>[] | null) ?? []).map((field) => ({
          ...field,
          allow_custom_note: false,
        }))

        return { data: legacyFields as CustomField[], error: null }
      }

      return {
        data: (primary.data as CustomField[] | null) ?? [],
        error: primary.error,
      }
    }

    Promise.all([
      fetchFields(),
      supabase.from('custom_field_values').select('field_id,value').eq('voter_id', voter.id),
    ]).then(([fieldRes, valueRes]) => {
      if (cancelled) {
        return
      }

      if (fieldRes.error) {
        toast.error(fieldRes.error.message)
        setCustomFields([])
        setCustomValues({})
        setLoadingCustomFields(false)
        return
      }

      if (valueRes.error) {
        toast.error(valueRes.error.message)
      }

      const fields = fieldRes.data ?? []
      const values = (valueRes.data as CustomFieldValueRow[] | null) ?? []
      const mappedValues = values.reduce<CustomFieldValueMap>((acc, row) => {
        acc[row.field_id] = row.value
        return acc
      }, {})

      setCustomFields(fields)
      setCustomValues(mappedValues)
      setLoadingCustomFields(false)
    })

    return () => {
      cancelled = true
    }
  }, [voter, voter?.id])

  const timeline = useMemo(
    () => logs.map((log) => ({ ...log, summary: `${log.action.toUpperCase()} on ${new Date(log.created_at).toLocaleString()}` })),
    [logs],
  )

  // Escape closes the drawer. Handled here (not just at the page level) so
  // the drawer works correctly wherever it's mounted from.
  useEffect(() => {
    if (!voter) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [voter, onClose])

  if (!voter) {
    return null
  }

  const extensionFromMime = (mimeType: string) => {
    if (mimeType === 'image/png') return 'png'
    if (mimeType === 'image/webp') return 'webp'
    if (mimeType === 'image/jpeg') return 'jpg'
    return 'jpg'
  }

  const uploadPhotoBlob = async (blob: Blob, source: 'upload' | 'camera' | 'paste') => {
    if (!canEditVoter) {
      toast.error('You do not have permission to edit voter records.')
      return
    }

    const extension = extensionFromMime(blob.type)
    const photoPath = `manual/${voter.epic_no}-${Date.now()}.${extension}`

    setUploadingPhoto(true)
    try {
      await uploadPhoto(photoPath, blob)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Photo upload failed.')
      return
    } finally {
      setUploadingPhoto(false)
    }

    setDraft((current) => ({ ...current, photo_url: photoPath }))
    toast.success(`Photo updated from ${source}. Click Save Changes to persist voter record.`)
  }

  const handlePickedFile = async (file: File | null, source: 'upload' | 'camera') => {
    if (!canEditVoter) {
      toast.error('You do not have permission to edit voter records.')
      return
    }

    if (!file) {
      return
    }
    await uploadPhotoBlob(file, source)
  }

  const handlePastePhoto = async (event: ClipboardEvent<HTMLDivElement>) => {
    if (!canEditVoter) {
      return
    }

    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))
    if (!imageItem) {
      return
    }

    event.preventDefault()
    const imageFile = imageItem.getAsFile()
    if (!imageFile) {
      toast.error('No image found in clipboard.')
      return
    }

    await uploadPhotoBlob(imageFile, 'paste')
  }

  const save = async () => {
    if (!canEditVoter) {
      toast.error('You do not have permission to edit voter records.')
      return
    }

    if (!String(draft.name ?? '').trim()) {
      toast.error('Name is required.')
      return
    }

    if (!String(draft.epic_no ?? '').trim()) {
      toast.error('EPIC is required.')
      return
    }

    for (const field of customFields) {
      if (!field.required) {
        continue
      }

      if (!hasValueForField(field, customValues[field.id])) {
        toast.error(`${field.label} is required.`)
        return
      }
    }

    setSaving(true)
    const { error } = await supabase
      .from('voters')
      .update({
        epic_no: String(draft.epic_no ?? '').trim(),
        name: draft.name,
        relative_name: draft.relative_name,
        relative_relation: draft.relative_relation,
        section_name: draft.section_name,
        ward_no: draft.ward_no,
        part_no: draft.part_no,
        section: draft.section,
        sr_no_roll: draft.sr_no_roll,
        house_no: draft.house_no,
        contact_no_1: draft.contact_no_1,
        contact_no_2: draft.contact_no_2,
        age: draft.age,
        date_of_birth: draft.date_of_birth,
        religion: draft.religion,
        gender: draft.gender,
        state: draft.state,
        voter_category: draft.voter_category,
        family_head_epic: draft.family_head_epic,
        family_label: draft.family_label,
        family_color: draft.family_color,
        row_color: draft.row_color,
        photo_url: draft.photo_url,
      })
      .eq('id', voter.id)

    if (error) {
      setSaving(false)
      toast.error(error.message)
      return
    }

    const normalized = customFields.map((field) => ({
      field_id: field.id,
      value: normalizeFieldValue(field, customValues[field.id]),
    }))

    const upsertRows = normalized
      .filter((entry) => entry.value !== null)
      .map((entry) => ({
        voter_id: voter.id,
        field_id: entry.field_id,
        value: entry.value,
      }))

    const clearFieldIds = normalized.filter((entry) => entry.value === null).map((entry) => entry.field_id)

    if (upsertRows.length) {
      const { error: upsertError } = await supabase.from('custom_field_values').upsert(upsertRows, {
        onConflict: 'voter_id,field_id',
      })

      if (upsertError) {
        setSaving(false)
        toast.error(upsertError.message)
        return
      }
    }

    if (clearFieldIds.length) {
      const { error: deleteError } = await supabase
        .from('custom_field_values')
        .delete()
        .eq('voter_id', voter.id)
        .in('field_id', clearFieldIds)

      if (deleteError) {
        setSaving(false)
        toast.error(deleteError.message)
        return
      }
    }

    setSaving(false)

    toast.success('Voter and custom fields updated')
    await onSaved()
  }

  const copyEpic = async () => {
    try {
      await navigator.clipboard.writeText(String(draft.epic_no ?? ''))
      toast.success('EPIC number copied.')
    } catch {
      toast.error('Unable to copy EPIC number.')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/25 md:items-stretch md:justify-end"
      onClick={onClose}
    >
      <div
        className="flex h-[92vh] w-full max-w-2xl flex-col bg-white md:h-full"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-muted md:hidden" />
        <div className="mb-2 flex items-center justify-between px-4 pt-2 md:mb-4 md:pt-4">
          <h2 className="text-xl font-semibold text-ink">Voter Detail</h2>
          <Button variant="icon" aria-label="Close voter detail" title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {!canEditVoter ? (
          <p className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You can view voter details, but only admin or users granted edit access by admin can change voter information.
          </p>
        ) : null}

        {isMobile && !mobileEditing ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            <div className="rounded-xl border border-line bg-white p-4">
              <div className="flex items-center gap-4">
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-line bg-muted">
                  {photoPreviewUrl ? (
                    <img src={photoPreviewUrl} alt={`${voter.name} profile`} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-brand-100 text-lg font-bold text-brand-700">
                      {voter.name
                        .split(' ')
                        .map((part) => part.charAt(0))
                        .slice(0, 2)
                        .join('')
                        .toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold text-ink">{draft.name}</p>
                  <p className="truncate text-sm text-ink-secondary">EPIC: {draft.epic_no}</p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="inline-flex rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
                  Part {draft.part_no ?? '-'}
                </span>
                <span className="inline-flex rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
                  Section {draft.section ?? '-'}
                </span>
                <span className="inline-flex rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
                  Sr No {draft.sr_no_roll ?? '-'}
                </span>
                {voterCategoryLabel(draft.voter_category) ? (
                  <span className="inline-flex rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700">
                    {voterCategoryLabel(draft.voter_category)}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <a
                  href={draft.contact_no_1 ?? draft.contact_no_2 ? `tel:${draft.contact_no_1 ?? draft.contact_no_2}` : '#'}
                  className={`inline-flex h-12 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium ${
                    draft.contact_no_1 ?? draft.contact_no_2
                      ? 'border-line text-ink-secondary'
                      : 'pointer-events-none border-line text-ink-tertiary'
                  }`}
                >
                  <Phone className="h-4 w-4" />
                  Call
                </a>
                <button
                  type="button"
                  onClick={() => void copyEpic()}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-line px-3 text-sm font-medium text-ink-secondary"
                >
                  <Copy className="h-4 w-4" />
                  Copy EPIC
                </button>
              </div>

              {canEditVoter ? (
                <Button className="mt-2 h-11 w-full" onClick={() => setMobileEditing(true)}>
                  <Pencil className="h-4 w-4" />
                  Edit details
                </Button>
              ) : null}
            </div>

            <div className="mt-4 rounded-xl border border-line bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Contact</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <SummaryRow label="Contact 1" value={draft.contact_no_1} />
                <SummaryRow label="Contact 2" value={draft.contact_no_2} />
                <SummaryRow label="House No" value={draft.house_no} />
                <SummaryRow label="Relative" value={draft.relative_name} />
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-line bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Location</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <SummaryRow label="Ward No" value={draft.ward_no} />
                <SummaryRow label="Part No" value={draft.part_no} />
                <SummaryRow label="Section" value={draft.section} />
                <SummaryRow label="SR No Roll" value={draft.sr_no_roll} />
                <SummaryRow label="Section Name" value={draft.section_name} />
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-line bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-tertiary">Personal</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <SummaryRow label="Gender" value={draft.gender} />
                <SummaryRow label="Age" value={draft.age} />
                <SummaryRow label="Date of Birth" value={draft.date_of_birth} />
                <SummaryRow label="Religion" value={draft.religion} />
                <SummaryRow label="State" value={draft.state} />
                <SummaryRow label="Family Head EPIC" value={draft.family_head_epic} />
                <SummaryRow label="Family Label" value={draft.family_label} />
                <SummaryRow label="Row Color" value={draft.row_color} />
              </div>
            </div>

            {customFields.length ? (
              <section className="mt-4 rounded-xl border border-line bg-white">
                <button
                  type="button"
                  className="flex h-12 w-full items-center justify-between px-4 text-left"
                  onClick={() => setMobileCustomOpen((open) => !open)}
                  aria-expanded={mobileCustomOpen}
                >
                  <span className="text-sm font-semibold text-ink">Custom fields</span>
                  <ChevronDown className={cn('h-5 w-5 text-ink-tertiary transition-transform', mobileCustomOpen && 'rotate-180')} />
                </button>
                {mobileCustomOpen ? (
                  <div className="border-t border-line p-4">
                    <div className="grid grid-cols-2 gap-3">
                      {customFields.map((field) => {
                        const raw = customValues[field.id]
                        const value = getStoredFieldValue(raw)
                        const displayValue = Array.isArray(value) ? value.join(', ') : value
                        return <SummaryRow key={field.id} label={field.label} value={displayValue} />
                      })}
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section className="mt-4 rounded-xl border border-line bg-white">
              <button
                type="button"
                className="flex h-12 w-full items-center justify-between px-4 text-left"
                onClick={() => setMobileLogsOpen((open) => !open)}
                aria-expanded={mobileLogsOpen}
              >
                <span className="text-sm font-semibold text-ink">Activity history</span>
                <ChevronDown className={cn('h-5 w-5 text-ink-tertiary transition-transform', mobileLogsOpen && 'rotate-180')} />
              </button>
              {mobileLogsOpen ? (
                <div className="border-t border-line p-4">
                  {!canViewActivityLogs ? (
                    <p className="text-sm text-ink-secondary">Activity history is available to admin and sub-admin users.</p>
                  ) : null}
                  {canViewActivityLogs && !timeline.length ? (
                    <p className="text-sm text-ink-secondary">No activity records visible for this voter.</p>
                  ) : null}
                  <ul className="space-y-2">
                    {timeline.map((item) => (
                      <li key={item.id} className="rounded-lg border border-line p-3 text-sm">
                        <p className="font-medium text-ink">{item.summary}</p>
                        <p className="mt-1 inline-flex items-center gap-1 text-xs text-ink-tertiary">
                          <Clock className="h-3.5 w-3.5" />
                          {formatDate(item.created_at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 md:pb-4">
        <fieldset disabled={!canEditVoter}>
          <div className="grid gap-3 rounded-xl border border-line p-4 md:grid-cols-2">
          <div className="md:col-span-2 rounded-xl border border-line p-3">
            <p className="text-sm font-medium text-ink">Photo</p>
            <div
              className="mt-2 rounded-xl border border-dashed border-line bg-muted p-3"
              onPaste={(event) => {
                void handlePastePhoto(event)
              }}
            >
              <div className="flex flex-wrap items-start gap-3">
                <div className="h-24 w-24 overflow-hidden rounded-lg border border-line bg-white">
                  {photoPreviewUrl ? (
                    <img src={photoPreviewUrl} alt={`${voter.name} profile`} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-ink-tertiary">No Photo</div>
                  )}
                </div>
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-xs font-medium text-ink-secondary"
                    onClick={() => uploadInputRef.current?.click()}
                    disabled={uploadingPhoto}
                  >
                    <ImageUp className="h-4 w-4" />
                    Upload
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-xs font-medium text-ink-secondary"
                    onClick={() => cameraInputRef.current?.click()}
                    disabled={uploadingPhoto}
                  >
                    <Camera className="h-4 w-4" />
                    Camera
                  </button>
                  <p className="hidden text-xs text-ink-secondary md:block">Paste image directly here with Ctrl+V for copy/paste upload.</p>
                </div>
              </div>
              <input
                ref={uploadInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                aria-label="Upload voter photo"
                title="Upload voter photo"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  void handlePickedFile(file, 'upload')
                  event.target.value = ''
                }}
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                aria-label="Capture voter photo"
                title="Capture voter photo"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  void handlePickedFile(file, 'camera')
                  event.target.value = ''
                }}
              />
            </div>
          </div>

          <label className="text-sm text-ink-secondary">
            Name
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.name ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            EPIC
            <input
              className={`mt-1 h-10 w-full rounded-lg border border-line px-2 ${canEditVoter ? '' : 'bg-muted'}`}
              value={String(draft.epic_no ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, epic_no: event.target.value }))}
              readOnly={!canEditVoter}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Ward No
            <input
              type="number"
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.ward_no ?? '')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  ward_no: event.target.value === '' ? null : Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Part No
            <input
              type="number"
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.part_no ?? '')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  part_no: event.target.value === '' ? null : Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Section
            <input
              type="number"
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.section ?? '')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  section: event.target.value === '' ? null : Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="text-sm text-ink-secondary">
            SR No Roll
            <input
              type="number"
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.sr_no_roll ?? '')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  sr_no_roll: event.target.value === '' ? null : Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Section Name
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.section_name ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, section_name: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Relative Name
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.relative_name ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, relative_name: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Relation
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.relative_relation ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, relative_relation: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Family Head EPIC
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.family_head_epic ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, family_head_epic: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Family Label
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.family_label ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, family_label: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Family Color
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.family_color ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, family_color: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Row Color
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.row_color ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, row_color: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Contact 1
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.contact_no_1 ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, contact_no_1: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Contact 2
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.contact_no_2 ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, contact_no_2: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            House No
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.house_no ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, house_no: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Date of Birth
            <input
              type="date"
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.date_of_birth ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, date_of_birth: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Age
            <input
              type="number"
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.age ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, age: Number(event.target.value) || null }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Religion
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.religion ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, religion: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Gender
            <select
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.gender ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, gender: event.target.value as Voter['gender'] }))}
            >
              <option value="">-</option>
              <option value="MALE">MALE</option>
              <option value="FEMALE">FEMALE</option>
              <option value="OTHER">OTHER</option>
            </select>
          </label>
          <label className="text-sm text-ink-secondary">
            State
            <input
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={String(draft.state ?? '')}
              onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value }))}
            />
          </label>
          <label className="text-sm text-ink-secondary">
            Category
            <select
              className="mt-1 h-10 w-full rounded-lg border border-line px-2"
              value={draft.voter_category ?? ''}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  voter_category: (event.target.value || null) as Voter['voter_category'],
                }))
              }
            >
              <option value="">-</option>
              {VOTER_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          </div>

          <section className="mt-4 rounded-xl border border-line bg-white p-4">
          <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-sm font-semibold text-emerald-900">Custom Voter Fields</p>
            <p className="mt-1 text-xs text-emerald-800">
              Fill these as needed. These fields are created by admins and help capture additional voter information.
            </p>
            <p className="mt-1 text-xs text-emerald-800">For option-based fields, use Clear buttons to reset selection before saving.</p>
          </div>

          {loadingCustomFields ? <p className="text-sm text-ink-secondary">Loading custom fields...</p> : null}
          {!loadingCustomFields && !customFields.length ? (
            <p className="text-sm text-ink-secondary">No custom fields configured yet.</p>
          ) : null}

          {!loadingCustomFields && customFields.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {customFields.map((field) => {
                const currentValue = customValues[field.id]
                const fieldValue = getStoredFieldValue(currentValue)
                const fieldNote = getStoredFieldNote(currentValue)
                const options = parseFieldOptions(field.options)

                if (field.field_type === 'textarea') {
                  return (
                    <label key={field.id} className="text-sm text-ink-secondary md:col-span-2">
                      {field.label}
                      {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                      <textarea
                        className="mt-1 min-h-24 w-full rounded-lg border border-line px-2 py-2"
                        value={String(fieldValue ?? '')}
                        onChange={(event) =>
                          setCustomValues((existing) => ({
                            ...existing,
                            [field.id]: withUpdatedFieldValue(existing[field.id], event.target.value),
                          }))
                        }
                      />
                      {field.allow_custom_note ? (
                        <>
                          <p className="mt-2 text-xs text-ink-tertiary">Custom note (optional)</p>
                          <textarea
                            className="mt-1 min-h-20 w-full rounded-lg border border-line px-2 py-2"
                            placeholder="Add a note for this field"
                            value={fieldNote}
                            onChange={(event) =>
                              setCustomValues((existing) => ({
                                ...existing,
                                [field.id]: withUpdatedFieldNote(existing[field.id], event.target.value),
                              }))
                            }
                          />
                        </>
                      ) : null}
                    </label>
                  )
                }

                if (field.field_type === 'number') {
                  return (
                    <label key={field.id} className="text-sm text-ink-secondary">
                      {field.label}
                      {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                      <input
                        type="number"
                        className="mt-1 h-10 w-full rounded-lg border border-line px-2"
                        value={String(fieldValue ?? '')}
                        onChange={(event) =>
                          setCustomValues((existing) => ({
                            ...existing,
                            [field.id]: withUpdatedFieldValue(existing[field.id], event.target.value),
                          }))
                        }
                      />
                      {field.allow_custom_note ? (
                        <label className="mt-2 block text-xs text-ink-tertiary">
                          Custom note (optional)
                          <textarea
                            className="mt-1 min-h-20 w-full rounded-lg border border-line px-2 py-2 text-sm"
                            placeholder="Add a note for this field"
                            value={fieldNote}
                            onChange={(event) =>
                              setCustomValues((existing) => ({
                                ...existing,
                                [field.id]: withUpdatedFieldNote(existing[field.id], event.target.value),
                              }))
                            }
                          />
                        </label>
                      ) : null}
                    </label>
                  )
                }

                if (field.field_type === 'date') {
                  return (
                    <label key={field.id} className="text-sm text-ink-secondary">
                      {field.label}
                      {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                      <input
                        type="date"
                        className="mt-1 h-10 w-full rounded-lg border border-line px-2"
                        value={String(fieldValue ?? '')}
                        onChange={(event) =>
                          setCustomValues((existing) => ({
                            ...existing,
                            [field.id]: withUpdatedFieldValue(existing[field.id], event.target.value),
                          }))
                        }
                      />
                      {field.allow_custom_note ? (
                        <label className="mt-2 block text-xs text-ink-tertiary">
                          Custom note (optional)
                          <textarea
                            className="mt-1 min-h-20 w-full rounded-lg border border-line px-2 py-2 text-sm"
                            placeholder="Add a note for this field"
                            value={fieldNote}
                            onChange={(event) =>
                              setCustomValues((existing) => ({
                                ...existing,
                                [field.id]: withUpdatedFieldNote(existing[field.id], event.target.value),
                              }))
                            }
                          />
                        </label>
                      ) : null}
                    </label>
                  )
                }

                if (field.field_type === 'dropdown') {
                  return (
                    <label key={field.id} className="text-sm text-ink-secondary">
                      {field.label}
                      {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                      <select
                        className="mt-1 h-10 w-full rounded-lg border border-line px-2"
                        value={String(fieldValue ?? '')}
                        onChange={(event) =>
                          setCustomValues((existing) => ({
                            ...existing,
                            [field.id]: withUpdatedFieldValue(existing[field.id], event.target.value),
                          }))
                        }
                      >
                        <option value="">Select an option</option>
                        {options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="mt-2 rounded-md border border-line px-2 py-1 text-xs text-ink-secondary"
                        onClick={() =>
                          setCustomValues((existing) => ({
                            ...existing,
                            [field.id]: withUpdatedFieldValue(existing[field.id], ''),
                          }))
                        }
                      >
                        Clear Selection
                      </button>
                      {field.allow_custom_note ? (
                        <label className="mt-2 block text-xs text-ink-tertiary">
                          Custom note (optional)
                          <textarea
                            className="mt-1 min-h-20 w-full rounded-lg border border-line px-2 py-2 text-sm"
                            placeholder="Add a note for this field"
                            value={fieldNote}
                            onChange={(event) =>
                              setCustomValues((existing) => ({
                                ...existing,
                                [field.id]: withUpdatedFieldNote(existing[field.id], event.target.value),
                              }))
                            }
                          />
                        </label>
                      ) : null}
                    </label>
                  )
                }

                if (field.field_type === 'radio') {
                  return (
                    <div key={field.id} className="rounded-lg border border-line p-3 text-sm text-ink-secondary">
                      <p className="font-medium text-ink-secondary">
                        {field.label}
                        {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-3">
                        {options.map((option) => (
                          <label key={option} className="inline-flex items-center gap-2">
                            <input
                              type="radio"
                              name={`custom-${field.id}`}
                              value={option}
                              checked={String(fieldValue ?? '') === option}
                              onChange={(event) =>
                                setCustomValues((existing) => ({
                                  ...existing,
                                  [field.id]: withUpdatedFieldValue(existing[field.id], event.target.value),
                                }))
                              }
                            />
                            {option}
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="mt-2 rounded-md border border-line px-2 py-1 text-xs text-ink-secondary"
                        onClick={() =>
                          setCustomValues((existing) => ({
                            ...existing,
                            [field.id]: withUpdatedFieldValue(existing[field.id], ''),
                          }))
                        }
                      >
                        Clear Selection
                      </button>
                      {field.allow_custom_note ? (
                        <label className="mt-2 block text-xs text-ink-tertiary">
                          Custom note (optional)
                          <textarea
                            className="mt-1 min-h-20 w-full rounded-lg border border-line px-2 py-2 text-sm"
                            placeholder="Add a note for this field"
                            value={fieldNote}
                            onChange={(event) =>
                              setCustomValues((existing) => ({
                                ...existing,
                                [field.id]: withUpdatedFieldNote(existing[field.id], event.target.value),
                              }))
                            }
                          />
                        </label>
                      ) : null}
                    </div>
                  )
                }

                if (field.field_type === 'multiselect' || field.field_type === 'checkbox') {
                  const selected = Array.isArray(fieldValue)
                    ? fieldValue.map((item) => String(item))
                    : fieldValue
                      ? [String(fieldValue)]
                      : []

                  return (
                    <div key={field.id} className="rounded-lg border border-line p-3 text-sm text-ink-secondary md:col-span-2">
                      <p className="font-medium text-ink-secondary">
                        {field.label}
                        {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                      </p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {options.map((option) => (
                          <label key={option} className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selected.includes(option)}
                              onChange={(event) => {
                                setCustomValues((existing) => {
                                  const currentValueForField = getStoredFieldValue(existing[field.id])
                                  const current = Array.isArray(currentValueForField)
                                    ? currentValueForField.map((item) => String(item))
                                    : []

                                  const updated = event.target.checked
                                    ? Array.from(new Set([...current, option]))
                                    : current.filter((item) => item !== option)

                                  return {
                                    ...existing,
                                    [field.id]: withUpdatedFieldValue(existing[field.id], updated),
                                  }
                                })
                              }}
                            />
                            {option}
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="mt-2 rounded-md border border-line px-2 py-1 text-xs text-ink-secondary"
                        onClick={() =>
                          setCustomValues((existing) => ({
                            ...existing,
                            [field.id]: withUpdatedFieldValue(existing[field.id], []),
                          }))
                        }
                      >
                        Clear Selection
                      </button>
                      {field.allow_custom_note ? (
                        <label className="mt-2 block text-xs text-ink-tertiary">
                          Custom note (optional)
                          <textarea
                            className="mt-1 min-h-20 w-full rounded-lg border border-line px-2 py-2 text-sm"
                            placeholder="Add a note for this field"
                            value={fieldNote}
                            onChange={(event) =>
                              setCustomValues((existing) => ({
                                ...existing,
                                [field.id]: withUpdatedFieldNote(existing[field.id], event.target.value),
                              }))
                            }
                          />
                        </label>
                      ) : null}
                    </div>
                  )
                }

                return (
                  <label key={field.id} className="text-sm text-ink-secondary">
                    {field.label}
                    {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                    <input
                      className="mt-1 h-10 w-full rounded-lg border border-line px-2"
                      value={String(fieldValue ?? '')}
                      onChange={(event) =>
                        setCustomValues((existing) => ({
                          ...existing,
                          [field.id]: withUpdatedFieldValue(existing[field.id], event.target.value),
                        }))
                      }
                    />
                    {field.allow_custom_note ? (
                      <label className="mt-2 block text-xs text-ink-tertiary">
                        Custom note (optional)
                        <textarea
                          className="mt-1 min-h-20 w-full rounded-lg border border-line px-2 py-2 text-sm"
                          placeholder="Add a note for this field"
                          value={fieldNote}
                          onChange={(event) =>
                            setCustomValues((existing) => ({
                              ...existing,
                              [field.id]: withUpdatedFieldNote(existing[field.id], event.target.value),
                            }))
                          }
                        />
                      </label>
                    ) : null}
                  </label>
                )
              })}
            </div>
          ) : null}
          </section>

          <div className="mt-4 hidden justify-end md:flex">
            <Button onClick={() => void save()} disabled={saving || !canEditVoter} loading={saving}>
              <Save className="h-4 w-4" />
              Save changes
            </Button>
          </div>
        </fieldset>

        <section className="mt-5 hidden rounded-xl border border-line p-4 md:block">
          <h3 className="text-lg font-semibold text-ink">Activity History</h3>
          {!canViewActivityLogs ? <p className="mt-2 text-sm text-ink-secondary">Activity history is available to admin and sub-admin users.</p> : null}
          {canViewActivityLogs && !timeline.length ? <p className="mt-2 text-sm text-ink-secondary">No activity records visible for this voter.</p> : null}
          <ul className="mt-3 space-y-2">
            {timeline.map((item) => (
              <li key={item.id} className="rounded-lg border border-line p-3 text-sm">
                <p className="font-medium text-ink">{item.summary}</p>
                <p className="mt-1 inline-flex items-center gap-1 text-xs text-ink-tertiary">
                  <Clock className="h-3.5 w-3.5" />
                  {formatDate(item.created_at)}
                </p>
              </li>
            ))}
          </ul>
        </section>
          </div>
        )}

        {isMobile && mobileEditing ? (
          <div className="shrink-0 border-t border-line bg-white p-4 pb-6">
            <div className="flex gap-3">
              <Button
                variant="secondary"
                className="h-11 flex-1"
                onClick={() => {
                  setDraft(voter)
                  setMobileEditing(false)
                }}
              >
                Cancel
              </Button>
              <Button className="h-11 flex-1" onClick={() => void save()} disabled={saving || !canEditVoter} loading={saving}>
                <Save className="h-4 w-4" />
                Save changes
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
