import { useState } from 'react'
import toast from 'react-hot-toast'
import { Plus, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

export function CreateHeaderGroupModal({ onClose, onSaved }: {
  onClose: () => void
  onSaved: (id: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) { toast.error('Group name is required.'); return }
    setSaving(true)
    const { data: newGroup, error: gErr } = await supabase.from('groups').insert({
      name: trimmed,
      group_type: 'custom',
      part_no: null,
      description: description.trim() || null,
      created_by: null,
      parent_group_id: null,
    }).select('id').single()
    setSaving(false)
    if (gErr || !newGroup) { toast.error(gErr?.message ?? 'Failed to create group.'); return }
    toast.success(`Group "${trimmed}" created. Add sub-groups under it to add voters.`)
    onClose()
    await onSaved(newGroup.id)
  }

  return (
    <Dialog open onClose={onClose} labelledBy="create-header-group-title">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 id="create-header-group-title" className="text-lg font-semibold text-ink">New Group</h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">A group is a header. Voters are added to sub-groups inside it.</p>
          </div>
          <Button variant="icon" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></Button>
        </div>

        <label className="block text-sm text-ink-secondary">
          Group Name
          <input autoFocus className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            placeholder="e.g. Self Help" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create() }} />
        </label>

        <label className="mt-4 block text-sm text-ink-secondary">
          Description (optional)
          <input className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            placeholder="e.g. Self help groups formed in the ward" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} loading={saving} onClick={() => void create()}>
            <Plus className="h-4 w-4" /> Create Group
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
