import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'

export function LoginPage() {
  const { session, refetch } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  if (session) {
    return <Navigate to="/dashboard" replace />
  }

  const loginWithPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoading(true)

    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Sign in failed')
      }

      toast.success('Welcome back')
      await refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-[image:var(--wash)] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[image:var(--kpi-hairline)] text-sm font-semibold text-white shadow-sm">
            V
          </span>
          <span className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">VoterData</span>
        </div>
        <div className="max-w-md">
          <p className="font-display text-4xl font-semibold tracking-[-0.03em] text-ink">
            Constituency voter intelligence
          </p>
          <p className="mt-3 text-sm leading-6 text-ink-secondary">
            \ CMS console for roll work, families, field days, and booth turnout.
          </p>
        </div>
        <p className="text-xs text-ink-tertiary">Workspace for constituency Management.</p>
      </div>

      <div className="flex min-h-screen items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[image:var(--kpi-hairline)] text-sm font-semibold text-white shadow-sm">
              V
            </span>
            <span className="font-display text-[15px] font-semibold text-ink">VoterData</span>
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-[-0.03em] text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-ink-tertiary">Use your email and password to continue.</p>

          <form className="mt-8 space-y-4" onSubmit={loginWithPassword}>
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              className="h-11"
              required
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="h-11"
              required
            />
            <Button type="submit" className="h-11 w-full" disabled={loading} loading={loading}>
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
