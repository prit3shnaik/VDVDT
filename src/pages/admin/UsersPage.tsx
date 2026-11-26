import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Copy, Plus } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/Button'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import type { UserProfile } from '../../lib/types'
import { FAST_NAV_CACHE_MAX_AGE_MS, readCachedCollection, writeCachedCollection } from '../../lib/voterCache'

const USERS_CACHE_KEY = 'vote:admin:users'
const USER_WARDS_CACHE_KEY = 'vote:admin:user-ward-options'

/**
 * User management runs through the typed admin API (not the generic table shim), because
 * creating a user also has to create a Better Auth credential, and role changes are
 * guarded server-side (no self-edit, no removing the last admin, no privilege escalation).
 */
async function adminApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

  const text = await res.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!res.ok) {
    const message =
      (payload as { error?: string } | null)?.error ?? `Request failed (${res.status})`
    throw new Error(message)
  }

  return payload as T
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

export function UsersPage() {
  const { profile } = useAuth()
  const [users, setUsers] = useState<UserProfile[]>([])
  const [wardOptions, setWardOptions] = useState<number[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<UserProfile>>({})
  const [passwordDraft, setPasswordDraft] = useState('')
  const [newUser, setNewUser] = useState({
    full_name: '',
    email: '',
    password: '',
    role: 'user' as UserProfile['role'],
    allowed_wards: [] as number[],
    can_edit: false,
  })

  useEffect(() => {
    const cachedUsers = readCachedCollection<UserProfile>(USERS_CACHE_KEY, 'global', FAST_NAV_CACHE_MAX_AGE_MS)
    if (cachedUsers) {
      setUsers(cachedUsers)
    }

    const cachedWards = readCachedCollection<number>(USER_WARDS_CACHE_KEY, 'global', FAST_NAV_CACHE_MAX_AGE_MS)
    if (cachedWards) {
      setWardOptions(cachedWards)
    }
  }, [])

  const loadUsers = async () => {
    try {
      const { users: rows } = await adminApi<{ users: UserProfile[] }>('/api/admin/users?limit=500')
      setUsers(rows)
      writeCachedCollection<UserProfile>(USERS_CACHE_KEY, 'global', rows)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  useEffect(() => {
    void loadUsers()
  }, [])

  useEffect(() => {
    async function loadWardOptions() {
      const { data, error } = await supabase
        .from('voters')
        .select('ward_no')
        .not('ward_no', 'is', null)
        .limit(10000)

      if (error) {
        return
      }

      const wards = Array.from(
        new Set(
          ((data as Array<{ ward_no: number | null }> | null) ?? [])
            .map((row) => row.ward_no)
            .filter((value): value is number => value !== null),
        ),
      ).sort((a, b) => a - b)

      setWardOptions(wards)
      writeCachedCollection<number>(USER_WARDS_CACHE_KEY, 'global', wards)
    }

    void loadWardOptions()
  }, [])

  const createUser = async () => {
    if (!newUser.email || !newUser.password) {
      toast.error('email and temporary password are required.')
      return
    }

    if (newUser.password.trim().length < 8) {
      toast.error('Temporary password must be at least 8 characters.')
      return
    }

    const normalizedRole = newUser.role
    const isAdminRole = normalizedRole === 'admin'
    const normalizedEmail = newUser.email.trim().toLowerCase()

    const wards = newUser.allowed_wards

    const allowedWards = isAdminRole ? [] : wards
    const canEdit = isAdminRole ? true : newUser.can_edit

    try {
      await adminApi('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: normalizedEmail,
          password: newUser.password.trim(),
          fullName: newUser.full_name || null,
          role: normalizedRole,
          allowedWards,
          canEdit,
        }),
      })
    } catch (error) {
      toast.error(errorMessage(error))
      return
    }

    toast.success(isAdminRole ? 'Admin user created with full access' : 'User created')
    setNewUser({ full_name: '', email: '', password: '', role: 'user', allowed_wards: [], can_edit: false })
    await loadUsers()
  }

  const saveEdit = async (id: string) => {
    const role = (draft.role as UserProfile['role']) ?? 'user'
    const wards = role === 'user' ? ((draft.allowed_wards as number[] | undefined) ?? []) : []
    const canEdit = role === 'admin' ? true : Boolean(draft.can_edit)

    try {
      await adminApi(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: draft.full_name ?? null,
          role,
          allowedWards: wards,
          canEdit,
        }),
      })
    } catch (error) {
      toast.error(errorMessage(error))
      return
    }

    toast.success('User updated')
    setEditingId(null)
    setDraft({})
    await loadUsers()
  }

  const deleteUser = async (id: string) => {
    try {
      await adminApi(`/api/admin/users/${id}`, { method: 'DELETE' })
    } catch (error) {
      toast.error(errorMessage(error))
      return
    }
    toast.success('User deleted')
    await loadUsers()
  }

  const resetPassword = async (userId: string) => {
    if (!passwordDraft.trim()) {
      toast.error('Enter a new password first.')
      return
    }

    if (passwordDraft.trim().length < 8) {
      toast.error('Password must be at least 8 characters.')
      return
    }

    try {
      await adminApi(`/api/admin/users/${userId}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: passwordDraft.trim() }),
      })
    } catch (error) {
      toast.error(errorMessage(error))
      return
    }

    toast.success('Password updated for selected user.')
    setResettingId(null)
    setPasswordDraft('')
  }

  if (profile?.role !== 'admin') {
    return (
      <div>
        <PageHeader
          title="Users"
          description="Only admin can manage users, roles, and edit permissions."
        />
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          You have view-only access. Contact an admin to create users, change roles, or grant voter edit access.
        </section>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Users"
        description="User CRUD with role and ward restrictions."
        action={
          <Button onClick={createUser}>
            <Plus className="h-4 w-4" />
            Add User
          </Button>
        }
      />

      <section className="mb-4 grid gap-3 rounded-xl border border-line bg-white p-4 md:grid-cols-3">
        <input
          className="h-11 rounded-xl border border-line px-3 text-sm"
          placeholder="Full name"
          aria-label="New user full name"
          value={newUser.full_name}
          onChange={(event) => setNewUser((current) => ({ ...current, full_name: event.target.value }))}
        />
        <input
          className="h-11 rounded-xl border border-line px-3 text-sm"
          placeholder="Email"
          aria-label="New user email"
          value={newUser.email}
          onChange={(event) => setNewUser((current) => ({ ...current, email: event.target.value }))}
        />
        <input
          className="h-11 rounded-xl border border-line px-3 text-sm"
          placeholder="Temporary password"
          type="password"
          aria-label="New user temporary password"
          value={newUser.password}
          onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))}
        />
        <select
          className="h-11 rounded-xl border border-line px-3 text-sm"
          value={newUser.role}
          aria-label="New user role"
          title="New user role"
          onChange={(event) =>
            setNewUser((current) => {
              const role = event.target.value as UserProfile['role']
              if (role !== 'user') {
                return { ...current, role, allowed_wards: [] }
              }
              return { ...current, role }
            })
          }
        >
          <option value="admin">admin</option>
          <option value="sub-admin">sub-admin</option>
          <option value="user">user</option>
        </select>
        <select
          multiple
          className="h-24 rounded-xl border border-line px-3 py-2 text-sm"
          aria-label="New user allowed wards"
          value={newUser.allowed_wards.map(String)}
          disabled={newUser.role !== 'user'}
          onChange={(event) => {
            const wards = Array.from(event.target.selectedOptions)
              .map((option) => Number.parseInt(option.value, 10))
              .filter((value) => !Number.isNaN(value))

            setNewUser((current) => ({ ...current, allowed_wards: wards }))
          }}
        >
          {wardOptions.map((ward) => (
            <option key={ward} value={String(ward)}>
              Ward {ward}
            </option>
          ))}
        </select>
        <label className="inline-flex h-11 items-center gap-2 rounded-xl border border-line px-3 text-sm">
          <input
            type="checkbox"
            aria-label="New user can edit"
            checked={newUser.can_edit}
            onChange={(event) => setNewUser((current) => ({ ...current, can_edit: event.target.checked }))}
          />
          Can edit
        </label>
        <p className="md:col-span-3 text-xs text-ink-tertiary">
          Ward assignment is only for role user. Admin and sub-admin always save with no ward restriction.
        </p>
        <p className="md:col-span-3 text-xs text-amber-700">
          Note: Email changes are disabled here to avoid auth/profile mismatch. Create a new user if email must change.
        </p>
      </section>

      <section className="rounded-xl border border-line bg-white p-4">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-ink-tertiary">
                <th className="py-2">Name</th>
                <th className="py-2">Email</th>
                <th className="py-2">Role</th>
                <th className="py-2">Allowed Wards</th>
                <th className="py-2">Can Edit</th>
                <th className="py-2">Auth UUID</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-line">
                  <td className="py-2 text-ink">
                    {editingId === user.id ? (
                      <input
                        className="h-9 rounded-lg border border-line px-2"
                        value={String(draft.full_name ?? user.full_name ?? '')}
                        aria-label="Edit full name"
                        title="Edit full name"
                        placeholder="Full name"
                        onChange={(event) => setDraft((current) => ({ ...current, full_name: event.target.value }))}
                      />
                    ) : (
                      user.full_name ?? '-'
                    )}
                  </td>
                  <td className="py-2 text-ink-secondary">{user.email}</td>
                  <td className="py-2 capitalize text-ink-secondary">
                    {editingId === user.id ? (
                      <select
                        className="h-9 rounded-lg border border-line px-2"
                        value={String(draft.role ?? user.role)}
                        aria-label="Edit role"
                        title="Edit role"
                        onChange={(event) =>
                          setDraft((current) => {
                            const role = event.target.value as UserProfile['role']
                            if (role !== 'user') {
                              return { ...current, role, allowed_wards: [] }
                            }
                            return { ...current, role }
                          })
                        }
                      >
                        <option value="admin">admin</option>
                        <option value="sub-admin">sub-admin</option>
                        <option value="user">user</option>
                      </select>
                    ) : (
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${
                          user.role === 'admin'
                            ? 'border-brand-100 bg-brand-50 text-brand-700'
                            : user.role === 'sub-admin'
                              ? 'border-line bg-muted text-ink-secondary'
                              : 'border-[var(--success-border)] bg-[var(--success-fill)] text-[var(--success)]'
                        }`}
                      >
                        {user.role}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-ink-secondary">
                    {editingId === user.id ? (
                      <select
                        multiple
                        className="h-24 rounded-lg border border-line px-2 py-1"
                        value={((draft.allowed_wards as number[] | undefined) ?? user.allowed_wards).map(String)}
                        aria-label="Edit allowed wards"
                        title="Edit allowed wards"
                        disabled={(draft.role ?? user.role) !== 'user'}
                        onChange={(event) => {
                          const wards = Array.from(event.target.selectedOptions)
                            .map((option) => Number.parseInt(option.value, 10))
                            .filter((value) => !Number.isNaN(value))

                          setDraft((current) => ({ ...current, allowed_wards: wards }))
                        }}
                      >
                        {wardOptions.map((ward) => (
                          <option key={ward} value={String(ward)}>
                            Ward {ward}
                          </option>
                        ))}
                      </select>
                    ) : (
                      user.allowed_wards.join(', ') || '-'
                    )}
                  </td>
                  <td className="py-2 text-ink-secondary">
                    {editingId === user.id ? (
                      <input
                        type="checkbox"
                        aria-label="Edit can edit permission"
                        checked={Boolean(draft.can_edit ?? user.can_edit)}
                        onChange={(event) => setDraft((current) => ({ ...current, can_edit: event.target.checked }))}
                      />
                    ) : user.can_edit ? 'Yes' : 'No'}
                  </td>
                  <td className="py-2">
                    {user.auth_user_id ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-tertiary hover:bg-muted hover:text-ink"
                        title={user.auth_user_id}
                        onClick={() => {
                          void navigator.clipboard.writeText(user.auth_user_id)
                          toast.success('Auth UUID copied')
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </button>
                    ) : (
                      <span className="text-xs text-ink-tertiary">-</span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex gap-2">
                      {editingId === user.id ? (
                        <>
                          <button
                            type="button"
                            className="rounded-md bg-brand-500 px-2 py-1 text-xs font-semibold text-white"
                            onClick={() => void saveEdit(user.id)}
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
                          <button
                            type="button"
                            className="rounded-md border border-line px-2 py-1 text-xs"
                            onClick={() => {
                              setEditingId(user.id)
                              setDraft({
                                full_name: user.full_name,
                                email: user.email,
                                role: user.role,
                                allowed_wards: user.allowed_wards,
                                can_edit: user.can_edit,
                              })
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-600"
                            onClick={() => void deleteUser(user.id)}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-brand-200 px-2 py-1 text-xs text-brand-700"
                            onClick={() => {
                              setResettingId(user.id)
                              setPasswordDraft('')
                            }}
                          >
                            Change Password
                          </button>
                        </>
                      )}
                    </div>
                    {resettingId === user.id ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          className="h-8 rounded-md border border-line px-2 text-xs"
                          type="password"
                          placeholder="New password"
                          aria-label="New password"
                          title="New password"
                          value={passwordDraft}
                          onChange={(event) => setPasswordDraft(event.target.value)}
                        />
                        <button
                          type="button"
                          className="rounded-md bg-brand-500 px-2 py-1 text-xs font-semibold text-white"
                          onClick={() => void resetPassword(user.id)}
                        >
                          Update
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-line px-2 py-1 text-xs"
                          onClick={() => {
                            setResettingId(null)
                            setPasswordDraft('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
