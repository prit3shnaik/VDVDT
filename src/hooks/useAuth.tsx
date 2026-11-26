import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { UserProfile, UserRole } from '../lib/types'

interface BetterAuthSession {
  user: {
    id: string
    email: string
    name: string
  }
  session: {
    token: string
    expiresAt: number
  }
}

interface AuthContextValue {
  session: BetterAuthSession | null
  profile: UserProfile | null
  loading: boolean
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
  refetch: () => Promise<void>
  isAdminAreaAllowed: boolean
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

async function fetchProfile(): Promise<{ user: BetterAuthSession['user']; profile: UserProfile } | null> {
  try {
    const res = await fetch('/api/me')
    if (!res.ok) return null
    const data = await res.json()
    return { user: data.user, profile: data.profile }
  } catch {
    return null
  }
}

function isAdminRole(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'sub-admin'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BetterAuthSession | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const data = await fetchProfile()
      if (data) {
        // Extract session from better-auth cookie implicitly by the /api/me endpoint
        setSession({
          user: data.user,
          session: { token: '', expiresAt: 0 },
        })
        setProfile(data.profile)
      } else {
        setSession(null)
        setProfile(null)
      }
    } catch {
      setSession(null)
      setProfile(null)
    }
  }, [])

  const refreshProfile = useCallback(async () => {
    await refetch()
  }, [refetch])

  useEffect(() => {
    let mounted = true

    const initAuth = async () => {
      try {
        const data = await fetchProfile()
        if (mounted) {
          if (data) {
            setSession({
              user: data.user,
              session: { token: '', expiresAt: 0 },
            })
            setProfile(data.profile)
          }
          setLoading(false)
        }
      } catch {
        if (mounted) {
          setSession(null)
          setProfile(null)
          setLoading(false)
        }
      }
    }

    initAuth()

    return () => {
      mounted = false
    }
  }, [])

  const signOut = async () => {
    try {
      await fetch('/api/auth/sign-out', { method: 'POST' })
    } catch {
      // Ignore errors
    }
    setSession(null)
    setProfile(null)
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      profile,
      loading,
      signOut,
      refreshProfile,
      refetch,
      isAdminAreaAllowed: isAdminRole(profile?.role),
    }),
    [session, profile, loading, refreshProfile, refetch],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider')
  }

  return context
}
