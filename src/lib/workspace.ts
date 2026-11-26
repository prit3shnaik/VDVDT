/**
 * Active workspace on the client.
 *
 * The server is the authority: it checks `workspace_members` for the id sent in
 * `X-Workspace-Id` and rejects the request otherwise. This module only carries
 * the user's current choice and makes sure every same-origin request states it.
 *
 * Cache keys include the workspace id so two constituencies never share a
 * cached roll in one browser profile.
 */

const ACTIVE_WORKSPACE_KEY = 'vote:active-workspace'

let fetchInstalled = false

export function getActiveWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY)
  } catch {
    return null
  }
}

export function setActiveWorkspaceId(workspaceId: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (workspaceId) window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId)
    else window.localStorage.removeItem(ACTIVE_WORKSPACE_KEY)
  } catch {
    // Ignore private-mode/storage failures.
  }
  window.dispatchEvent(new CustomEvent('workspace-changed', { detail: workspaceId }))
}

/** Append the workspace id to a cache key. */
export function workspaceScopedKey(base: string): string {
  return `${base}:ws:${getActiveWorkspaceId() ?? 'none'}`
}

/** Include the workspace in a cache scope string. */
export function withWorkspaceScope(scope: string): string {
  return `ws:${getActiveWorkspaceId() ?? 'none'}|${scope}`
}

/**
 * Add `X-Workspace-Id` to every same-origin fetch. Called once from main.tsx so
 * existing fetch/supabase call sites do not each need to remember the header.
 */
export function installWorkspaceFetch(): void {
  if (fetchInstalled || typeof window === 'undefined') return
  fetchInstalled = true
  const original = window.fetch.bind(window)

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const workspaceId = getActiveWorkspaceId()
    if (!workspaceId) return original(input, init)

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (!headers.has('x-workspace-id')) headers.set('x-workspace-id', workspaceId)

    if (input instanceof Request) {
      return original(new Request(input, { ...init, headers }))
    }
    return original(input, { ...init, headers })
  }
}
