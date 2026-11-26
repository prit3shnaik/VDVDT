// Replaces Supabase `createSignedUrl(...)` calls. No resize-on-request happens here —
// `t500` was already generated once at upload time by the Worker photo pipeline.
export function photoUrl(path: string, size: 'orig' | 't500' = 't500'): string {
  return `/media/${size}/${path}`
}

export async function uploadPhoto(key: string, blob: Blob): Promise<{ key: string }> {
  const res = await fetch(`/api/photos/${key}`, {
    method: 'PUT',
    body: blob,
    credentials: 'include',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? res.statusText)
  }
  return res.json()
}
