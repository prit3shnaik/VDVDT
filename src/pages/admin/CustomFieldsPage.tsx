import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Plus } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { supabase } from '../../lib/supabase'
import type { CustomField } from '../../lib/types'
import { FAST_NAV_CACHE_MAX_AGE_MS, readCachedCollection, writeCachedCollection } from '../../lib/voterCache'

const CUSTOM_FIELDS_CACHE_KEY = 'vote:admin:custom-fields'

const OPTION_FIELD_TYPES: CustomField['field_type'][] = ['dropdown', 'multiselect', 'checkbox', 'radio']

const supportsOptions = (fieldType: CustomField['field_type']) => OPTION_FIELD_TYPES.includes(fieldType)

const parseOptionsInput = (value: string) => {
  const parsed = value
    .split(/\r?\n|,/) 
    .map((item) => item.trim())
    .filter(Boolean)

  return Array.from(new Set(parsed))
}

const optionsToInput = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean)
      .join('\n')
  }

  if (typeof value === 'string') {
    try {
      const maybeArray = JSON.parse(value) as unknown
      if (Array.isArray(maybeArray)) {
        return maybeArray
          .map((item) => String(item).trim())
          .filter(Boolean)
          .join('\n')
      }
    } catch {
      return value
    }
    return value
  }

  return ''
}

export function CustomFieldsPage() {
  const [fields, setFields] = useState<CustomField[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [supportsCustomNote, setSupportsCustomNote] = useState(true)
  const [newField, setNewField] = useState({
    name: '',
    label: '',
    field_type: 'text' as CustomField['field_type'],
    required: false,
    show_in_card: false,
    allow_custom_note: false,
    optionsInput: '',
  })
  const [draft, setDraft] = useState<Partial<CustomField> & { optionsInput?: string }>({})

  useEffect(() => {
    const cached = readCachedCollection<CustomField>(CUSTOM_FIELDS_CACHE_KEY, 'global', FAST_NAV_CACHE_MAX_AGE_MS)
    if (cached) {
      setFields(cached)
    }
  }, [])

  const loadFields = async () => {
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
        toast.error(fallback.error.message)
        return
      }

      setSupportsCustomNote(false)
      const legacyFields = ((fallback.data as Omit<CustomField, 'allow_custom_note'>[] | null) ?? []).map((field) => ({
        ...field,
        allow_custom_note: false,
      }))
      setFields(legacyFields)
      writeCachedCollection<CustomField>(CUSTOM_FIELDS_CACHE_KEY, 'global', legacyFields)
      return
    }

    if (primary.error) {
      toast.error(primary.error.message)
      return
    }

    setSupportsCustomNote(true)
    const nextFields = (primary.data as CustomField[] | null) ?? []
    setFields(nextFields)
    writeCachedCollection<CustomField>(CUSTOM_FIELDS_CACHE_KEY, 'global', nextFields)
  }

  useEffect(() => {
    void loadFields()
  }, [])

  const createField = async () => {
    if (!newField.name || !newField.label) {
      toast.error('Field name and label are required.')
      return
    }

    const options = parseOptionsInput(newField.optionsInput)
    if (supportsOptions(newField.field_type) && options.length === 0) {
      toast.error('Please add at least one option for this field type.')
      return
    }

    const insertPayload: Record<string, unknown> = {
      name: newField.name,
      label: newField.label,
      field_type: newField.field_type,
      options: supportsOptions(newField.field_type) ? options : null,
      required: newField.required,
      show_in_card: newField.show_in_card,
      position: fields.length + 1,
    }

    if (supportsCustomNote) {
      insertPayload.allow_custom_note = newField.allow_custom_note
    }

    const { error } = await supabase.from('custom_fields').insert(insertPayload)

    if (error) {
      toast.error(error.message)
      return
    }

    toast.success('Custom field created')
    setNewField({
      name: '',
      label: '',
      field_type: 'text',
      required: false,
      show_in_card: false,
      allow_custom_note: false,
      optionsInput: '',
    })
    await loadFields()
  }

  const saveField = async (id: string) => {
    const currentField = fields.find((field) => field.id === id)
    if (!currentField) {
      toast.error('Unable to find the selected field.')
      return
    }

    const targetFieldType = (draft.field_type ?? currentField.field_type) as CustomField['field_type']
    const optionsInput = draft.optionsInput ?? optionsToInput(currentField.options)
    const options = parseOptionsInput(optionsInput)

    if (supportsOptions(targetFieldType) && options.length === 0) {
      toast.error('Please add at least one option for this field type.')
      return
    }

    const updatePayload: Record<string, unknown> = {
      name: draft.name,
      label: draft.label,
      field_type: targetFieldType,
      options: supportsOptions(targetFieldType) ? options : null,
      required: draft.required,
      show_in_card: draft.show_in_card,
    }

    if (supportsCustomNote) {
      updatePayload.allow_custom_note = draft.allow_custom_note
    }

    const { error } = await supabase
      .from('custom_fields')
      .update(updatePayload)
      .eq('id', id)

    if (error) {
      toast.error(error.message)
      return
    }

    toast.success('Custom field updated')
    setEditingId(null)
    setDraft({})
    await loadFields()
  }

  const deleteField = async (id: string) => {
    const { error } = await supabase.from('custom_fields').delete().eq('id', id)
    if (error) {
      toast.error(error.message)
      return
    }

    toast.success('Custom field deleted')
    await loadFields()
  }

  return (
    <div>
      <PageHeader
        title="Custom Fields"
        description="Dynamic voter field builder maintained by admins."
        action={
          <button
            type="button"
            onClick={createField}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white"
          >
            <Plus className="h-4 w-4" />
            New Field
          </button>
        }
      />

      <section className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">Voter Info Visibility</p>
        <p className="mt-1">
          Every custom field here is meant for voter information capture. Use <strong>Show in card</strong> when you also
          want that value visible in voter cards and quick summaries.
        </p>
      </section>

      <section className="mb-4 grid gap-3 rounded-xl border border-line bg-white p-4 md:grid-cols-2">
        <label className="text-sm text-ink-secondary">
          Field Key
          <input
            className="mt-1 h-11 w-full rounded-xl border border-line px-3 text-sm"
            placeholder="example: booth_agent"
            value={newField.name}
            onChange={(event) => setNewField((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label className="text-sm text-ink-secondary">
          Label
          <input
            className="mt-1 h-11 w-full rounded-xl border border-line px-3 text-sm"
            placeholder="example: Booth Agent"
            value={newField.label}
            onChange={(event) => setNewField((current) => ({ ...current, label: event.target.value }))}
          />
        </label>
        <label className="text-sm text-ink-secondary">
          Field Type
          <select
            className="mt-1 h-11 w-full rounded-xl border border-line px-3 text-sm"
            value={newField.field_type}
            onChange={(event) =>
              setNewField((current) => ({ ...current, field_type: event.target.value as CustomField['field_type'] }))
            }
          >
            <option value="text">text</option>
            <option value="textarea">textarea</option>
            <option value="number">number</option>
            <option value="date">date</option>
            <option value="dropdown">dropdown</option>
            <option value="multiselect">multiselect</option>
            <option value="checkbox">checkbox</option>
            <option value="radio">radio</option>
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="inline-flex h-11 items-center gap-2 rounded-xl border border-line px-3 text-sm">
            <input
              type="checkbox"
              checked={newField.required}
              onChange={(event) => setNewField((current) => ({ ...current, required: event.target.checked }))}
            />
            Required
          </label>
          <label className="inline-flex h-11 items-center gap-2 rounded-xl border border-line px-3 text-sm">
            <input
              type="checkbox"
              checked={newField.show_in_card}
              onChange={(event) => setNewField((current) => ({ ...current, show_in_card: event.target.checked }))}
            />
            Show in card
          </label>
          {supportsCustomNote ? (
            <label className="inline-flex h-11 items-center gap-2 rounded-xl border border-line px-3 text-sm">
              <input
                type="checkbox"
                checked={newField.allow_custom_note}
                onChange={(event) => setNewField((current) => ({ ...current, allow_custom_note: event.target.checked }))}
              />
              Allow custom note
            </label>
          ) : null}
        </div>
        {!supportsCustomNote ? (
          <p className="text-xs text-amber-700 md:col-span-2">
            Custom note support is unavailable until the latest database migration is applied.
          </p>
        ) : null}
        {supportsOptions(newField.field_type) ? (
          <label className="text-sm text-ink-secondary md:col-span-2">
            Options (one per line or comma separated)
            <textarea
              className="mt-1 min-h-24 w-full rounded-xl border border-line px-3 py-2 text-sm"
              placeholder={'Active\nInactive\nPending'}
              value={newField.optionsInput}
              onChange={(event) => setNewField((current) => ({ ...current, optionsInput: event.target.value }))}
            />
            <p className="mt-1 text-xs text-ink-tertiary">
              These options will be shown in voter info selection inputs. Tip: keep labels short and clear; users can clear
              selections later in voter details.
            </p>
          </label>
        ) : null}
      </section>

      <section className="rounded-xl border border-line bg-white p-4">
        <ul className="divide-y divide-line text-sm">
          {fields.map((field) => (
            <li key={field.id} className="flex items-center justify-between py-3">
              <div>
                {editingId === field.id ? (
                  <div className="flex flex-wrap gap-2">
                    <input
                      className="h-9 rounded-lg border border-line px-2"
                      value={String(draft.label ?? field.label)}
                      onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
                    />
                    <input
                      className="h-9 rounded-lg border border-line px-2"
                      value={String(draft.name ?? field.name)}
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    />
                    <select
                      className="h-9 rounded-lg border border-line px-2"
                      value={String(draft.field_type ?? field.field_type)}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, field_type: event.target.value as CustomField['field_type'] }))
                      }
                    >
                      <option value="text">text</option>
                      <option value="textarea">textarea</option>
                      <option value="number">number</option>
                      <option value="date">date</option>
                      <option value="dropdown">dropdown</option>
                      <option value="multiselect">multiselect</option>
                      <option value="checkbox">checkbox</option>
                      <option value="radio">radio</option>
                    </select>
                    {supportsOptions((draft.field_type ?? field.field_type) as CustomField['field_type']) ? (
                      <textarea
                        className="min-h-20 w-full rounded-lg border border-line px-2 py-1"
                        placeholder={'Option 1\nOption 2\nOption 3'}
                        value={String(draft.optionsInput ?? optionsToInput(field.options))}
                        onChange={(event) => setDraft((current) => ({ ...current, optionsInput: event.target.value }))}
                      />
                    ) : null}
                  </div>
                ) : (
                  <>
                    <p className="font-medium text-ink">{field.label}</p>
                    <p className="text-ink-tertiary">
                      {field.name} · {field.field_type}
                    </p>
                    <p className="mt-1 text-xs text-ink-tertiary">{field.allow_custom_note ? 'Note enabled' : 'No note'}</p>
                    {supportsOptions(field.field_type) ? (
                      <p className="mt-1 text-xs text-ink-tertiary">
                        Options: {parseOptionsInput(optionsToInput(field.options)).join(', ') || 'None'}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {editingId === field.id ? (
                  <>
                    <label className="inline-flex items-center gap-1 text-xs text-ink-secondary">
                      <input
                        type="checkbox"
                        checked={Boolean(draft.required ?? field.required)}
                        onChange={(event) => setDraft((current) => ({ ...current, required: event.target.checked }))}
                      />
                      Required
                    </label>
                    <label className="inline-flex items-center gap-1 text-xs text-ink-secondary">
                      <input
                        type="checkbox"
                        checked={Boolean(draft.show_in_card ?? field.show_in_card)}
                        onChange={(event) => setDraft((current) => ({ ...current, show_in_card: event.target.checked }))}
                      />
                      Card
                    </label>
                    {supportsCustomNote ? (
                      <label className="inline-flex items-center gap-1 text-xs text-ink-secondary">
                        <input
                          type="checkbox"
                          checked={Boolean(draft.allow_custom_note ?? field.allow_custom_note)}
                          onChange={(event) => setDraft((current) => ({ ...current, allow_custom_note: event.target.checked }))}
                        />
                        Note
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="rounded-md bg-brand-500 px-2 py-1 text-xs font-semibold text-white"
                      onClick={() => void saveField(field.id)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-line px-2 py-1 text-xs"
                      onClick={() => {
                        setEditingId(null)
                        setDraft({})
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <div className="text-xs uppercase tracking-[0.1em] text-ink-tertiary">
                      {field.required ? 'Required' : 'Optional'} · {field.show_in_card ? 'Card' : 'Hidden'} · {field.allow_custom_note ? 'Note' : 'No note'}
                    </div>
                    <button
                      type="button"
                      className="rounded-md border border-line px-2 py-1 text-xs"
                      onClick={() => {
                        setEditingId(field.id)
                        setDraft({
                          name: field.name,
                          label: field.label,
                          field_type: field.field_type,
                          optionsInput: optionsToInput(field.options),
                          required: field.required,
                          show_in_card: field.show_in_card,
                          allow_custom_note: field.allow_custom_note,
                        })
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-600"
                      onClick={() => void deleteField(field.id)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
