import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { distinctSortedValues } from '../../lib/presence'
import { assignFamilyToLeader, isSpecialLeader } from '../../lib/teamLeaderCache'
import type { PresenceStatus, Voter } from '../../lib/types'

interface AddNewFamilyVoterModalProps {
  familyHeadEpic: string
  head: Voter | null
  members: Voter[]
  allVoters: Voter[]
  familyLeaderId: string | null
  familyLeaderNotes: string | null
  specialLeaderIds: Set<string>
  profileId: string | null
  onCreated: (voter: Voter) => void
  onClose: () => void
}

interface Draft {
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

function toNullableInt(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const parsed = Number.parseInt(text, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function buildDraft(head: Voter | null): Draft {
  return {
    epic_no: '',
    name: '',
    relative_name: '',
    relative_relation: '',
    ward_no: head?.ward_no != null ? String(head.ward_no) : '',
    part_no: head?.part_no != null ? String(head.part_no) : '',
    section: head?.section != null ? String(head.section) : '',
    sr_no_roll: '',
    house_no: head?.house_no ?? '',
    date_of_birth: '',
    contact_no_1: '',
    contact_no_2: '',
    gender: '',
    religion: head?.religion ?? '',
    religionOther: '',
    state: head?.state ?? '',
    stateOther: '',
  }
}

export function AddNewFamilyVoterModal({
  familyHeadEpic,
  head,
  members,
  allVoters,
  familyLeaderId,
  familyLeaderNotes,
  specialLeaderIds,
  profileId,
  onCreated,
  onClose,
}: AddNewFamilyVoterModalProps) {
  const [draft, setDraft] = useState<Draft>(() => buildDraft(head))
  const [saving, setSaving] = useState(false)
  const religionOptions = useMemo(() => distinctSortedValues(allVoters.map((row) => row.religion)), [allVoters])
  const stateOptions = useMemo(() => distinctSortedValues(allVoters.map((row) => row.state)), [allVoters])
  const inputClass = 'h-10 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100'
  const labelClass = 'mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary'

  const handleSave = async () => {
    const epicNo = draft.epic_no.trim().toUpperCase()
    const name = draft.name.trim()
    if (!epicNo) { toast.error('EPIC number is required.'); return }
    if (!name) { toast.error('Name is required.'); return }
    setSaving(true)
    try {
      const { data: existing, error: existingError } = await supabase
        .from('voters')
        .select('id,epic_no')
        .ilike('epic_no', epicNo)
        .limit(1)
      if (existingError) { toast.error(existingError.message); return }
      if ((existing ?? []).length > 0) {
        toast.error(`Duplicate EPIC found: ${existing?.[0]?.epic_no ?? epicNo}`)
        return
      }

      const religion = draft.religion === '__other__' ? draft.religionOther.trim() : draft.religion.trim()
      const state = draft.state === '__other__' ? draft.stateOther.trim() : draft.state.trim()
      const insertPayload = {
        epic_no: epicNo,
        name,
        relative_name: draft.relative_name.trim() || null,
        relative_relation: draft.relative_relation.trim() || null,
        ward_no: toNullableInt(draft.ward_no) ?? head?.ward_no ?? null,
        part_no: toNullableInt(draft.part_no) ?? head?.part_no ?? null,
        section: toNullableInt(draft.section) ?? head?.section ?? null,
        sr_no_roll: toNullableInt(draft.sr_no_roll),
        house_no: draft.house_no.trim() || head?.house_no || null,
        date_of_birth: draft.date_of_birth || null,
        contact_no_1: draft.contact_no_1.trim() || null,
        contact_no_2: draft.contact_no_2.trim() || null,
        family_head_epic: familyHeadEpic,
        gender: draft.gender || null,
        religion: religion || null,
        state: state || null,
        presence_status: (head?.presence_status ?? null) as PresenceStatus | null,
        presence_note: head?.presence_note ?? null,
      }

      const { data, error } = await supabase.from('voters').insert(insertPayload).select('*').maybeSingle()
      if (error) {
        if (error.message.toLowerCase().includes('duplicate') || error.message.toLowerCase().includes('voters_epic_no_key')) {
          toast.error('Duplicate EPIC number. Please use a unique EPIC.')
          return
        }
        toast.error(error.message)
        return
      }
      const created = data as Voter | null
      if (!created) {
        toast.error('Voter was created but could not be loaded.')
        return
      }

      if (familyLeaderId) {
        const treatAsParking = specialLeaderIds.has(familyLeaderId) || isSpecialLeader({ notes: familyLeaderNotes })
        await assignFamilyToLeader({
          voterIds: [created.id],
          toLeaderId: familyLeaderId,
          assignedBy: profileId,
          isDirectVoterIds: new Set(),
          specialLeaderIds: treatAsParking ? specialLeaderIds : specialLeaderIds,
        })
      }

      toast.success('Voter added to family.')
      onCreated(created)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-ink">Add new voter</h3>
            <p className="mt-1 text-sm text-ink-tertiary">
              Creates a voter in {head?.name ?? familyHeadEpic}. Ward, part, section, house, presence, and place follow the family head unless you change them.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 grid min-h-0 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="family-new-voter-epic">EPIC *</label>
            <input id="family-new-voter-epic" className={inputClass} placeholder="EPIC *" value={draft.epic_no} onChange={(event) => setDraft((current) => ({ ...current, epic_no: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-name">Name *</label>
            <input id="family-new-voter-name" className={inputClass} placeholder="Name *" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-relative-name">Relative name</label>
            <input id="family-new-voter-relative-name" className={inputClass} placeholder="Relative name" value={draft.relative_name} onChange={(event) => setDraft((current) => ({ ...current, relative_name: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-relation">Relation</label>
            <input id="family-new-voter-relation" className={inputClass} placeholder="Relation" value={draft.relative_relation} onChange={(event) => setDraft((current) => ({ ...current, relative_relation: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-ward">Ward no</label>
            <input id="family-new-voter-ward" className={inputClass} placeholder="Ward no" value={draft.ward_no} onChange={(event) => setDraft((current) => ({ ...current, ward_no: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-part">Part no</label>
            <input id="family-new-voter-part" className={inputClass} placeholder="Part no" value={draft.part_no} onChange={(event) => setDraft((current) => ({ ...current, part_no: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-section">Section</label>
            <input id="family-new-voter-section" className={inputClass} placeholder="Section" value={draft.section} onChange={(event) => setDraft((current) => ({ ...current, section: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-sr">SR no roll</label>
            <input id="family-new-voter-sr" className={inputClass} placeholder="SR no roll" value={draft.sr_no_roll} onChange={(event) => setDraft((current) => ({ ...current, sr_no_roll: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-house">House no</label>
            <input id="family-new-voter-house" className={inputClass} placeholder="House no" value={draft.house_no} onChange={(event) => setDraft((current) => ({ ...current, house_no: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-dob">Date of birth</label>
            <input id="family-new-voter-dob" type="date" className={inputClass} value={draft.date_of_birth} onChange={(event) => setDraft((current) => ({ ...current, date_of_birth: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-contact-1">Contact 1</label>
            <input id="family-new-voter-contact-1" className={inputClass} placeholder="Contact 1" value={draft.contact_no_1} onChange={(event) => setDraft((current) => ({ ...current, contact_no_1: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-contact-2">Contact 2</label>
            <input id="family-new-voter-contact-2" className={inputClass} placeholder="Contact 2" value={draft.contact_no_2} onChange={(event) => setDraft((current) => ({ ...current, contact_no_2: event.target.value }))} />
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-gender">Gender</label>
            <select id="family-new-voter-gender" className={inputClass} value={draft.gender} onChange={(event) => setDraft((current) => ({ ...current, gender: event.target.value as Draft['gender'] }))}>
              <option value="">Gender</option>
              <option value="MALE">MALE</option>
              <option value="FEMALE">FEMALE</option>
              <option value="OTHER">OTHER</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="family-new-voter-religion">Religion</label>
            <select id="family-new-voter-religion" className={inputClass} value={draft.religion} onChange={(event) => setDraft((current) => ({ ...current, religion: event.target.value }))}>
              <option value="">Religion</option>
              {religionOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
              <option value="__other__">Other</option>
            </select>
          </div>
          {draft.religion === '__other__' ? (
            <div>
              <label className={labelClass} htmlFor="family-new-voter-religion-other">Religion (other)</label>
              <input id="family-new-voter-religion-other" className={inputClass} placeholder="Religion (other)" value={draft.religionOther} onChange={(event) => setDraft((current) => ({ ...current, religionOther: event.target.value }))} />
            </div>
          ) : null}
          <div>
            <label className={labelClass} htmlFor="family-new-voter-state">State</label>
            <select id="family-new-voter-state" className={inputClass} value={draft.state} onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value }))}>
              <option value="">State</option>
              {stateOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
              <option value="__other__">Other</option>
            </select>
          </div>
          {draft.state === '__other__' ? (
            <div>
              <label className={labelClass} htmlFor="family-new-voter-state-other">State (other)</label>
              <input id="family-new-voter-state-other" className={inputClass} placeholder="State (other)" value={draft.stateOther} onChange={(event) => setDraft((current) => ({ ...current, stateOther: event.target.value }))} />
            </div>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="inline-flex h-10 items-center rounded-xl border border-line px-4 text-sm font-semibold text-ink-secondary hover:bg-muted">
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={() => void handleSave()} className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {saving ? 'Saving...' : 'Add voter'}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-ink-tertiary">{members.length} current member{members.length === 1 ? '' : 's'}.</p>
      </div>
    </div>
  )
}
