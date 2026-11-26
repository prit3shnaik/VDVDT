import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowLeft, Camera, ImageUp, Loader2, UserPlus, X } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/Button'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import { uploadPhoto } from '../../lib/photos'
import { distinctSortedValues } from '../../lib/presence'
import { invalidateVoterCache } from '../../lib/voterDataset'
import { buildWardScope, clearCachedCollection, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters } from '../../lib/voterCache'
import { cn } from '../../lib/utils'

const DASHBOARD_CACHE_KEY = 'vote:dashboard:voters-cache'
const LAST_LOCATION_KEY = 'vote:add-voter:last-location'
const MAX_PHOTO_BYTES = 15 * 1024 * 1024

interface NewVoterDraft {
  epic_no: string
  name: string
  relative_name: string
  relative_relation: string
  ward_no: string
  part_no: string
  section: string
  sr_no_roll: string
  house_no: string
  date_of_birth: string
  contact_no_1: string
  contact_no_2: string
  gender: '' | 'MALE' | 'FEMALE' | 'OTHER'
  religion: string
  religionOther: string
  state: string
  stateOther: string
}

interface LastLocation {
  ward_no: string
  part_no: string
  section: string
  religion: string
  state: string
}

const emptyDraft: NewVoterDraft = {
  epic_no: '',
  name: '',
  relative_name: '',
  relative_relation: '',
  ward_no: '',
  part_no: '',
  section: '',
  sr_no_roll: '',
  house_no: '',
  date_of_birth: '',
  contact_no_1: '',
  contact_no_2: '',
  gender: '',
  religion: '',
  religionOther: '',
  state: '',
  stateOther: '',
}

type EpicStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'unique' }
  | { kind: 'duplicate'; epic: string; name: string }
  | { kind: 'error'; message: string }

const inputClass = 'h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100'

function readLastLocation(): LastLocation | null {
  try {
    const raw = window.localStorage.getItem(LAST_LOCATION_KEY)
    if (!raw) return null
    return JSON.parse(raw) as LastLocation
  } catch {
    return null
  }
}

function writeLastLocation(location: LastLocation) {
  try {
    window.localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(location))
  } catch {
    // Ignore storage write errors.
  }
}

function initialDraft(): NewVoterDraft {
  const last = typeof window === 'undefined' ? null : readLastLocation()
  if (!last) return emptyDraft
  return {
    ...emptyDraft,
    ward_no: last.ward_no ?? '',
    part_no: last.part_no ?? '',
    section: last.section ?? '',
    religion: last.religion ?? '',
    state: last.state ?? '',
  }
}

function toNullableInt(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const parsed = Number.parseInt(text, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function deriveAgeFromDob(value: string | null): number | null {
  if (!value) return null
  const dob = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(dob.getTime())) return null
  const today = new Date()
  let age = today.getUTCFullYear() - dob.getUTCFullYear()
  const monthDiff = today.getUTCMonth() - dob.getUTCMonth()
  const dayDiff = today.getUTCDate() - dob.getUTCDate()
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1
  return age < 0 || age > 130 ? null : age
}

function extensionFromMime(mimeType: string) {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  return 'jpg'
}

function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  required?: boolean
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="block min-w-0">
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
        {label}
        {required ? <span className="text-[var(--danger)]"> *</span> : null}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[11px] text-ink-tertiary">{hint}</p> : null}
    </div>
  )
}

function SectionCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-white p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description ? <p className="mt-0.5 text-xs text-ink-tertiary">{description}</p> : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  )
}

export function AddVoterPage() {
  const { isAdminAreaAllowed, loading: authLoading, profile } = useAuth()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<NewVoterDraft>(initialDraft)
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [photoName, setPhotoName] = useState<string>('')
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const [epicStatus, setEpicStatus] = useState<EpicStatus>({ kind: 'idle' })
  const [religionOptions, setReligionOptions] = useState<string[]>([])
  const [stateOptions, setStateOptions] = useState<string[]>([])
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const dropRef = useRef<HTMLDivElement | null>(null)
  const epicInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const cached = readCachedVoters(DASHBOARD_CACHE_KEY, buildWardScope(profile?.role, profile?.allowed_wards), FAST_NAV_CACHE_MAX_AGE_MS)
    if (cached?.length) {
      setReligionOptions(distinctSortedValues(cached.map((voter) => voter.religion)))
      setStateOptions(distinctSortedValues(cached.map((voter) => voter.state)))
      return
    }

    let cancelled = false
    supabase
      .from('voters')
      .select('religion,state')
      .limit(800)
      .then(({ data }) => {
        if (cancelled || !data) return
        const rows = data as Array<{ religion: string | null; state: string | null }>
        setReligionOptions(distinctSortedValues(rows.map((row) => row.religion)))
        setStateOptions(distinctSortedValues(rows.map((row) => row.state)))
      })
    return () => {
      cancelled = true
    }
  }, [profile?.allowed_wards, profile?.role])

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview)
    }
  }, [photoPreview])

  const acceptPhoto = useCallback((file: Blob, name?: string) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Please add an image file.')
      return
    }
    if (file.size > MAX_PHOTO_BYTES) {
      toast.error('Image is too large (max 15 MB).')
      return
    }
    setPhotoPreview((current) => {
      if (current) URL.revokeObjectURL(current)
      return URL.createObjectURL(file)
    })
    setPhotoBlob(file)
    setPhotoName(name || (file instanceof File ? file.name : 'pasted-image'))
  }, [])

  const clearPhoto = useCallback(() => {
    setPhotoPreview((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    setPhotoBlob(null)
    setPhotoName('')
  }, [])

  useEffect(() => {
    const onPaste = (event: globalThis.ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (!items) return
      const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'))
      if (!imageItem) return
      const imageFile = imageItem.getAsFile()
      if (!imageFile) return
      event.preventDefault()
      acceptPhoto(imageFile, 'pasted-image')
      toast.success('Photo pasted.')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [acceptPhoto])

  const epicNo = draft.epic_no.trim().toUpperCase()

  useEffect(() => {
    if (epicNo.length < 3) {
      setEpicStatus({ kind: 'idle' })
      return
    }

    let cancelled = false
    setEpicStatus({ kind: 'checking' })
    const timer = window.setTimeout(() => {
      void supabase
        .from('voters')
        .select('id,epic_no,name')
        .ilike('epic_no', epicNo)
        .limit(1)
        .then(({ data, error }) => {
          if (cancelled) return
          if (error) {
            setEpicStatus({ kind: 'error', message: error.message })
            return
          }
          const existing = data?.[0]
          if (existing) {
            setEpicStatus({ kind: 'duplicate', epic: existing.epic_no, name: existing.name })
            return
          }
          setEpicStatus({ kind: 'unique' })
        })
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [epicNo])

  const canSubmit = useMemo(() => {
    if (saving) return false
    if (!epicNo || !draft.name.trim()) return false
    if (epicStatus.kind === 'duplicate' || epicStatus.kind === 'checking') return false
    return true
  }, [draft.name, epicNo, epicStatus.kind, saving])

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) acceptPhoto(file, file.name)
  }

  const handleZonePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))
    if (!imageItem) return
    event.preventDefault()
    const imageFile = imageItem.getAsFile()
    if (imageFile) acceptPhoto(imageFile, 'pasted-image')
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = draft.name.trim()
    if (!epicNo) {
      toast.error('EPIC number is required.')
      return
    }
    if (!name) {
      toast.error('Name is required.')
      return
    }
    if (epicStatus.kind === 'duplicate') {
      toast.error(`Duplicate EPIC found: ${epicStatus.epic}`)
      return
    }

    setSaving(true)
    try {
      const { data: existing, error: existingError } = await supabase
        .from('voters')
        .select('id,epic_no')
        .ilike('epic_no', epicNo)
        .limit(1)

      if (existingError) {
        toast.error(existingError.message)
        return
      }
      if ((existing ?? []).length > 0) {
        toast.error(`Duplicate EPIC found: ${existing?.[0]?.epic_no ?? epicNo}`)
        setEpicStatus({ kind: 'duplicate', epic: existing?.[0]?.epic_no ?? epicNo, name: '' })
        return
      }

      let photoPath: string | null = null
      if (photoBlob) {
        const extension = extensionFromMime(photoBlob.type)
        photoPath = `manual/${epicNo}-${Date.now()}.${extension}`
        await uploadPhoto(photoPath, photoBlob)
      }

      const religion = (draft.religion === '__other__' ? draft.religionOther : draft.religion).trim() || null
      const state = (draft.state === '__other__' ? draft.stateOther : draft.state).trim() || null
      const dateOfBirth = draft.date_of_birth || null

      const insertPayload = {
        epic_no: epicNo,
        name,
        relative_name: draft.relative_name.trim() || null,
        relative_relation: draft.relative_relation.trim() || null,
        ward_no: toNullableInt(draft.ward_no),
        part_no: toNullableInt(draft.part_no),
        section: toNullableInt(draft.section),
        sr_no_roll: toNullableInt(draft.sr_no_roll),
        house_no: draft.house_no.trim() || null,
        date_of_birth: dateOfBirth,
        age: deriveAgeFromDob(dateOfBirth),
        contact_no_1: draft.contact_no_1.trim() || null,
        contact_no_2: draft.contact_no_2.trim() || null,
        gender: draft.gender || null,
        religion,
        state,
        photo_url: photoPath,
      }

      const { error } = await supabase.from('voters').insert(insertPayload)
      if (error) {
        if (error.message.toLowerCase().includes('duplicate') || error.message.toLowerCase().includes('voters_epic_no_key')) {
          toast.error('Duplicate EPIC number. Please use a unique EPIC.')
          return
        }
        toast.error(error.message)
        return
      }

      await supabase.rpc('refresh_dashboard_stats')
      await invalidateVoterCache()
      clearCachedCollection(DASHBOARD_CACHE_KEY)
      writeLastLocation({
        ward_no: draft.ward_no,
        part_no: draft.part_no,
        section: draft.section,
        religion: draft.religion === '__other__' ? '' : draft.religion,
        state: draft.state === '__other__' ? '' : draft.state,
      })

      toast.success(`${name} added. You can add another voter.`)
      setDraft((current) => ({
        ...emptyDraft,
        ward_no: current.ward_no,
        part_no: current.part_no,
        section: current.section,
        religion: current.religion === '__other__' ? '' : current.religion,
        state: current.state === '__other__' ? '' : current.state,
      }))
      clearPhoto()
      setEpicStatus({ kind: 'idle' })
      window.setTimeout(() => epicInputRef.current?.focus(), 0)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add voter.')
    } finally {
      setSaving(false)
    }
  }

  if (authLoading) {
    return <p className="text-sm text-ink-secondary">Loading...</p>
  }

  if (!isAdminAreaAllowed) {
    return <Navigate to="/dashboard" replace />
  }

  return (
    <div>
      <PageHeader
        title="Add Missing Voter"
        description="Create a voter with photo, duplicate EPIC check, and booth details kept for the next entry."
        action={
          <Button variant="secondary" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        }
      />

      <form onSubmit={(event) => void handleSubmit(event)} className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-xl border border-line bg-white p-4">
            <h2 className="text-sm font-semibold text-ink">Photo</h2>
            <p className="mt-0.5 text-xs text-ink-tertiary">Upload, camera, drag and drop, or paste (Ctrl+V).</p>

            <div
              ref={dropRef}
              tabIndex={0}
              onPaste={handleZonePaste}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={cn(
                'mt-3 rounded-xl border-2 border-dashed p-3 transition',
                dragging ? 'border-brand-400 bg-brand-50' : 'border-line bg-muted',
              )}
            >
              <div className="mx-auto h-44 w-36 overflow-hidden rounded-xl border border-line bg-white">
                {photoPreview ? (
                  <img src={photoPreview} alt="Voter preview" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center text-xs text-ink-tertiary">
                    <ImageUp className="h-6 w-6 text-ink-tertiary" />
                    No photo yet
                  </div>
                )}
              </div>
              {photoName ? <p className="mt-2 truncate text-center text-[11px] text-ink-tertiary">{photoName}</p> : null}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button variant="secondary" size="compact" onClick={() => uploadInputRef.current?.click()}>
                  <ImageUp className="h-4 w-4" />
                  Upload
                </Button>
                <Button variant="secondary" size="compact" onClick={() => cameraInputRef.current?.click()}>
                  <Camera className="h-4 w-4" />
                  Camera
                </Button>
              </div>
              {photoPreview ? (
                <Button variant="ghost" size="compact" className="mt-2 w-full text-[var(--danger)]" onClick={clearPhoto}>
                  <X className="h-4 w-4" />
                  Remove photo
                </Button>
              ) : (
                <p className="mt-2 text-center text-[11px] text-ink-tertiary">Paste an image anywhere on this page.</p>
              )}
            </div>

            <input
              ref={uploadInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="Upload voter photo"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) acceptPhoto(file, file.name)
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
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) acceptPhoto(file, file.name)
                event.target.value = ''
              }}
            />
          </div>
        </aside>

        <div className="space-y-4 pb-24">
          <SectionCard title="Identity" description="EPIC is checked for duplicates as you type.">
            <Field label="EPIC No" htmlFor="new-voter-epic" required>
              <input
                id="new-voter-epic"
                ref={epicInputRef}
                className={cn(
                  inputClass,
                  epicStatus.kind === 'duplicate' && 'border-rose-300 focus:border-rose-400 focus:ring-rose-100',
                  epicStatus.kind === 'unique' && 'border-emerald-300 focus:border-emerald-400 focus:ring-emerald-100',
                )}
                placeholder="e.g. ABC1234567"
                value={draft.epic_no}
                autoComplete="off"
                autoFocus
                onChange={(event) => setDraft((current) => ({ ...current, epic_no: event.target.value.toUpperCase() }))}
              />
              {epicStatus.kind === 'checking' ? (
                <span className="mt-1 flex items-center gap-1 text-[11px] text-ink-tertiary">
                  <Loader2 className="h-3 w-3 animate-spin" /> Checking EPIC...
                </span>
              ) : null}
              {epicStatus.kind === 'unique' ? (
                <span className="mt-1 block text-[11px] font-medium text-emerald-700">EPIC is available.</span>
              ) : null}
              {epicStatus.kind === 'duplicate' ? (
                <span className="mt-1 block text-[11px] text-rose-700">
                  Duplicate EPIC{epicStatus.name ? ` — ${epicStatus.name}` : ''}.{' '}
                  <button
                    type="button"
                    className="font-semibold underline"
                    onClick={() => navigate(`/voters?q=${encodeURIComponent(epicStatus.epic)}`)}
                  >
                    Open existing voter
                  </button>
                </span>
              ) : null}
            </Field>
            <Field label="Name" htmlFor="new-voter-name" required>
              <input
                id="new-voter-name"
                className={inputClass}
                placeholder="Full name"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </Field>
            <Field label="Gender" htmlFor="new-voter-gender">
              <select
                id="new-voter-gender"
                className={inputClass}
                value={draft.gender}
                onChange={(event) => setDraft((current) => ({ ...current, gender: event.target.value as NewVoterDraft['gender'] }))}
              >
                <option value="">Select gender</option>
                <option value="MALE">MALE</option>
                <option value="FEMALE">FEMALE</option>
                <option value="OTHER">OTHER</option>
              </select>
            </Field>
            <Field label="Date of Birth" htmlFor="new-voter-dob" hint="Use the calendar or type as yyyy-mm-dd (shown as dd-mm-yyyy in most browsers).">
              <input
                id="new-voter-dob"
                type="date"
                className={inputClass}
                value={draft.date_of_birth}
                onChange={(event) => setDraft((current) => ({ ...current, date_of_birth: event.target.value }))}
              />
            </Field>
          </SectionCard>

          <SectionCard title="Family">
            <Field label="Relative Name" htmlFor="new-voter-relative-name">
              <input
                id="new-voter-relative-name"
                className={inputClass}
                placeholder="Father / husband / relative"
                value={draft.relative_name}
                onChange={(event) => setDraft((current) => ({ ...current, relative_name: event.target.value }))}
              />
            </Field>
            <Field label="Relation" htmlFor="new-voter-relation">
              <input
                id="new-voter-relation"
                className={inputClass}
                placeholder="e.g. Father, Husband"
                value={draft.relative_relation}
                onChange={(event) => setDraft((current) => ({ ...current, relative_relation: event.target.value }))}
              />
            </Field>
          </SectionCard>

          <SectionCard title="Location" description="Ward, part and section stay filled after you add a voter.">
            <Field label="Ward No" htmlFor="new-voter-ward">
              <input
                id="new-voter-ward"
                className={inputClass}
                inputMode="numeric"
                placeholder="Ward"
                value={draft.ward_no}
                onChange={(event) => setDraft((current) => ({ ...current, ward_no: event.target.value }))}
              />
            </Field>
            <Field label="Part No" htmlFor="new-voter-part">
              <input
                id="new-voter-part"
                className={inputClass}
                inputMode="numeric"
                placeholder="Part"
                value={draft.part_no}
                onChange={(event) => setDraft((current) => ({ ...current, part_no: event.target.value }))}
              />
            </Field>
            <Field label="Section" htmlFor="new-voter-section">
              <input
                id="new-voter-section"
                className={inputClass}
                inputMode="numeric"
                placeholder="Section"
                value={draft.section}
                onChange={(event) => setDraft((current) => ({ ...current, section: event.target.value }))}
              />
            </Field>
            <Field label="SR No Roll" htmlFor="new-voter-sr">
              <input
                id="new-voter-sr"
                className={inputClass}
                inputMode="numeric"
                placeholder="Serial on roll"
                value={draft.sr_no_roll}
                onChange={(event) => setDraft((current) => ({ ...current, sr_no_roll: event.target.value }))}
              />
            </Field>
            <Field label="House No" htmlFor="new-voter-house">
              <input
                id="new-voter-house"
                className={inputClass}
                placeholder="House number"
                value={draft.house_no}
                onChange={(event) => setDraft((current) => ({ ...current, house_no: event.target.value }))}
              />
            </Field>
          </SectionCard>

          <SectionCard title="Contact and extra">
            <Field label="Contact 1" htmlFor="new-voter-contact-1">
              <input
                id="new-voter-contact-1"
                className={inputClass}
                inputMode="tel"
                placeholder="Mobile"
                value={draft.contact_no_1}
                onChange={(event) => setDraft((current) => ({ ...current, contact_no_1: event.target.value }))}
              />
            </Field>
            <Field label="Contact 2" htmlFor="new-voter-contact-2">
              <input
                id="new-voter-contact-2"
                className={inputClass}
                inputMode="tel"
                placeholder="Alternate mobile"
                value={draft.contact_no_2}
                onChange={(event) => setDraft((current) => ({ ...current, contact_no_2: event.target.value }))}
              />
            </Field>
            <Field label="Religion" htmlFor="new-voter-religion">
              <select
                id="new-voter-religion"
                className={inputClass}
                value={draft.religion}
                onChange={(event) => setDraft((current) => ({ ...current, religion: event.target.value }))}
              >
                <option value="">Select religion</option>
                {religionOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
                <option value="__other__">Other</option>
              </select>
            </Field>
            {draft.religion === '__other__' ? (
              <Field label="Religion (other)" htmlFor="new-voter-religion-other">
                <input
                  id="new-voter-religion-other"
                  className={inputClass}
                  placeholder="Enter religion"
                  value={draft.religionOther}
                  onChange={(event) => setDraft((current) => ({ ...current, religionOther: event.target.value }))}
                />
              </Field>
            ) : null}
            <Field label="State" htmlFor="new-voter-state">
              <select
                id="new-voter-state"
                className={inputClass}
                value={draft.state}
                onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value }))}
              >
                <option value="">Select state</option>
                {stateOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
                <option value="__other__">Other</option>
              </select>
            </Field>
            {draft.state === '__other__' ? (
              <Field label="State (other)" htmlFor="new-voter-state-other">
                <input
                  id="new-voter-state-other"
                  className={inputClass}
                  placeholder="Enter state"
                  value={draft.stateOther}
                  onChange={(event) => setDraft((current) => ({ ...current, stateOther: event.target.value }))}
                />
              </Field>
            ) : null}
          </SectionCard>
        </div>

        <div className="fixed inset-x-0 bottom-16 z-20 border-t border-line bg-white px-4 py-3 md:bottom-0 md:left-auto lg:sticky lg:bottom-0 lg:col-span-2 lg:rounded-xl lg:border lg:px-5">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => navigate('/dashboard')}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} loading={saving}>
              {saving ? null : <UserPlus className="h-4 w-4" />}
              {saving ? 'Adding...' : 'Add voter'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
