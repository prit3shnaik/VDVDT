import { useState } from 'react'
import toast from 'react-hot-toast'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'
import { useAuth } from '../../hooks/useAuth'

export function ProfilePage() {
  const { profile } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)

  const initials = !profile?.full_name
    ? (profile?.email.slice(0, 2).toUpperCase() ?? 'NA')
    : profile.full_name
        .split(' ')
        .map((chunk) => chunk.charAt(0).toUpperCase())
        .slice(0, 2)
        .join('')

  const updatePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          newPassword: password,
          revokeOtherSessions: true,
        }),
      })

      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        throw new Error(payload?.message ?? payload?.error ?? 'Could not update password')
      }

      setCurrentPassword('')
      setPassword('')
      toast.success('Password updated')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update password')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageHeader title="Profile" description="Your account information and password controls." />

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl border border-line bg-white p-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
              {initials}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-ink">{profile?.full_name ?? 'User'}</h2>
              <p className="truncate text-sm text-ink-tertiary">{profile?.email ?? '-'}</p>
            </div>
            <span className="ml-auto inline-flex h-6 items-center rounded-full border border-brand-100 bg-brand-50 px-2 text-[11px] font-semibold capitalize text-brand-700">
              {profile?.role ?? 'user'}
            </span>
          </div>
        </article>

        <article className="rounded-xl border border-line bg-white p-4">
          <h2 className="text-sm font-semibold text-ink">Change password</h2>
          <form className="mt-3 space-y-3" onSubmit={updatePassword}>
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
            <Button type="submit" disabled={saving} loading={saving}>
              Update password
            </Button>
          </form>
        </article>
      </section>
    </div>
  )
}
