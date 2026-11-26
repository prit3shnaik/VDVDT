import { useEffect, useState } from 'react'
import { useAuth } from './useAuth'

interface FieldAccess {
  loading: boolean
  isAdmin: boolean
  isBoothAgent: boolean
  isFieldLeader: boolean
  isFieldOnly: boolean
}

export function useFieldAccess(): FieldAccess {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin' || profile?.role === 'sub-admin'
  const [isBoothAgent, setIsBoothAgent] = useState(false)
  const [isFieldLeader, setIsFieldLeader] = useState(false)
  const [loading, setLoading] = useState(!isAdmin)

  useEffect(() => {
    if (!profile) {
      setIsBoothAgent(false)
      setIsFieldLeader(false)
      setLoading(false)
      return
    }
    if (isAdmin) {
      setIsBoothAgent(false)
      setIsFieldLeader(false)
      setLoading(false)
      return
    }
    let cancelled = false
    const run = async () => {
      try {
        const [booth, field] = await Promise.all([
          fetch('/api/booth/me', { credentials: 'include' }),
          fetch('/api/field/me', { credentials: 'include' }),
        ])
        const boothJson = booth.ok ? await booth.json() as { booths?: unknown[] } : { booths: [] }
        const fieldJson = field.ok ? await field.json() as { leaders?: unknown[] } : { leaders: [] }
        if (cancelled) return
        setIsBoothAgent((boothJson.booths?.length ?? 0) > 0)
        setIsFieldLeader((fieldJson.leaders?.length ?? 0) > 0)
      } catch {
        if (!cancelled) {
          setIsBoothAgent(false)
          setIsFieldLeader(false)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [profile, isAdmin])

  return {
    loading,
    isAdmin: Boolean(isAdmin),
    isBoothAgent,
    isFieldLeader,
    isFieldOnly: !isAdmin && (isBoothAgent || isFieldLeader),
  }
}
