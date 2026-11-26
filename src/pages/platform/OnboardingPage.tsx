import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'
import { setActiveWorkspaceId } from '../../lib/workspace'

/**
 * First-run onboarding: create the paying org, then its first constituency
 * workspace. The Worker seeds categories, presence labels and special leader
 * buckets, so the workspace is usable immediately after this form.
 */
export function OnboardingPage() {
  const { refetch } = useAuth()
  const navigate = useNavigate()
  const [orgName, setOrgName] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [state, setState] = useState('')
  const [constituencyLabel, setConstituencyLabel] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!orgName.trim() || !workspaceName.trim()) {
      toast.error('Org and constituency names are required')
      return
    }

    setSaving(true)
    try {
      const orgRes = await fetch('/api/platform/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: orgName.trim() }),
      })
      const orgBody = await orgRes.json()
      if (!orgRes.ok) throw new Error(orgBody.error || 'Could not create the org')

      const wsRes = await fetch(`/api/platform/orgs/${orgBody.org.id}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: workspaceName.trim(),
          state: state.trim() || undefined,
          constituencyLabel: constituencyLabel.trim() || workspaceName.trim(),
        }),
      })
      const wsBody = await wsRes.json()
      if (!wsRes.ok) throw new Error(wsBody.error || 'Could not create the workspace')

      setActiveWorkspaceId(wsBody.workspace.id)
      await refetch()
      toast.success('Workspace ready')
      navigate('/dashboard', { replace: true })
      window.location.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Onboarding failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-xl rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">First-run setup</p>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
          Create your campaign workspace
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          An org is your campaign or candidate office. A workspace is one constituency.
          You can add more constituencies later without mixing their rolls.
        </p>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          <TextField
            label="Org name"
            placeholder="e.g. North District Campaign"
            value={orgName}
            onChange={(event) => setOrgName(event.target.value)}
            autoComplete="organization"
          />
          <TextField
            label="Constituency / workspace name"
            placeholder="e.g. Mormugao"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="State"
              placeholder="State"
              value={state}
              onChange={(event) => setState(event.target.value)}
            />
            <TextField
              label="Constituency label"
              placeholder="Shown on prints"
              value={constituencyLabel}
              onChange={(event) => setConstituencyLabel(event.target.value)}
            />
          </div>

          <div className="rounded-lg border border-line bg-muted/50 p-3 text-xs leading-5 text-ink-secondary">
            Setup seeds Home, Open, Away, BJP, Congress, MN Discussion and Away Discussion
            categories, presence labels, and this workspace&apos;s own Office / Shifted /
            Rented leader buckets.
          </div>

          <Button type="submit" loading={saving} className="w-full">
            Create workspace
          </Button>
        </form>
      </div>
    </div>
  )
}
