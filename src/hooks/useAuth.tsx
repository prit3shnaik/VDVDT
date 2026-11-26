import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { UserProfile, UserRole } from '../lib/types'
import { getActiveWorkspaceId, setActiveWorkspaceId } from '../lib/workspace'

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

export interface WorkspaceSummary {
  id: string
  org_id: string
  name: string
  slug: string | null
  status: string
  role?: string | null
}

export interface MembershipSummary {
  workspace: WorkspaceSummary
  role: string
}

export interface WorkspaceCategory {
  code: string
  label: string
  color: string | null
  position: number
  is_active: number
}

export interface PresenceOption {
  code: string
  label: string
}

interface MeResponse {
  user: BetterAuthSession['user']
  profile: UserProfile
  workspace?: WorkspaceSummary | null
  memberships?: MembershipSummary[]
  org?: { id: string; name: string; slug: string; display_name: string | null } | null
  categories?: WorkspaceCategory[]
  presenceOptions?: PresenceOption[]
  settings?: { product_display_name?: string | null } | null
}

interface AuthContextValue {
  session: BetterAuthSession | null
  profile: UserProfile | null
  loading: boolean
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
  refetch: () => Promise<void>
  isAdminAreaAllowed: boolean
  workspace: WorkspaceSummary | null
  memberships: MembershipSummary[]
  org: MeResponse['org']
  categories: WorkspaceCategory[]
  presenceOptions: PresenceOption[]
  productDisplayName: string
  switchWorkspace: (workspaceId: string) => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

async function fetchMe(): Promise<MeResponse | null> {
  try {
    const res = await fetch('/api/me')
    if (!res.ok) return null
    return (await res.json()) as MeResponse
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
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null)
  const [memberships, setMemberships] = useState<MembershipSummary[]>([])
  const [org, setOrg] = useState<MeResponse['org']>(null)
  const [categories, setCategories] = useState<WorkspaceCategory[]>([])
  const [presenceOptions, setPresenceOptions] = useState<PresenceOption[]>([])
  const [productDisplayName, setProductDisplayName] = useState('VoterData')
  const [loading, setLoading] = useState(true)

  const applyMe = useCallback((data: MeResponse | null) => {
    if (!data) {
      setSession(null)
      setProfile(null)
      setWorkspace(null)
      setMemberships([])
      return
    }

    setSession({ user: data.user, session: { token: '', expiresAt: 0 } })
    setProfile(data.profile)
    setWorkspace(data.workspace ?? null)
    setMemberships(data.memberships ?? [])
    setOrg(data.org ?? null)
    setCategories(data.categories ?? [])
    setPresenceOptions(data.presenceOptions ?? [])
    setProductDisplayName(data.settings?.product_display_name || 'VoterData')

    // Keep the browser's stored choice in sync with what the server resolved.
    // If the requested workspace is not a membership, the server falls back.
    if (data.workspace) {
      if (getActiveWorkspaceId() !== data.workspace.id) {
        setActiveWorkspaceId(data.workspace.id)
      }
    } else if (data.memberships?.length) {
      const first = data.memberships[0].workspace
      if (getActiveWorkspaceId() !== first.id) setActiveWorkspaceId(first.id)
    }
  }, [])

  const refetch = useCallback(async () => {
    applyMe(await fetchMe())
  }, [applyMe])

  const refreshProfile = useCallback(async () => {
    await refetch()
  }, [refetch])

  useEffect(() => {
    let mounted = true

    const initAuth = async () => {
      const data = await fetchMe()
      if (mounted) {
        applyMe(data)
        setLoading(false)
      }
    }

    initAuth()

    return () => {
      mounted = false
    }
  }, [applyMe])

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/sign-out', { method: 'POST' })
    } catch {
      // Ignore errors
    }
    setSession(null)
    setProfile(null)
    setWorkspace(null)
    setMemberships([])
    setActiveWorkspaceId(null)
  }, [])

  const switchWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId)
    // Full reload: every page's cached roll and query is workspace-scoped, and a
    // reload is the simplest way to guarantee no stale rows survive the switch.
    window.location.reload()
  }, [])

  const isAdminAreaAllowed = Boolean(profile && isAdminRole(profile.role))

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      profile,
      loading,
      signOut,
      refreshProfile,
      refetch,
      isAdminAreaAllowed,
      workspace,
      memberships,
      org,
      categories,
      presenceOptions,
      productDisplayName,
      switchWorkspace,
    }),
    [
      session,
      profile,
      loading,
      signOut,
      refreshProfile,
      refetch,
      isAdminAreaAllowed,
      workspace,
      memberships,
      org,
      categories,
      presenceOptions,
      productDisplayName,
      switchWorkspace,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
