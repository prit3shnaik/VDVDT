import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, requireWorkspace, type AuthedVars } from '../middleware/auth'
import { r2WorkspacePrefix } from '../lib/scope'
import { makeThumbnail, MAX_UPLOAD_BYTES } from '../lib/photos'

export const photos = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

function guessContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

// Body is the raw image bytes. Writes orig/{key} as uploaded and t500/{key} as a
// one-time 500x500 webp derivative — no resize-on-request, so no Images/Resizing billing.
photos.put('/api/photos/*', requireUser, requireWorkspace, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin' && !profile.can_edit) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const workspace = c.get('workspace')!
  const key = c.req.path.replace('/api/photos/', '')
  if (!key || key.includes('..')) return c.json({ error: 'Missing photo key' }, 400)
  const prefix = r2WorkspacePrefix(workspace.org_id, workspace.id, 'photos')

  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.byteLength === 0) return c.json({ error: 'Empty file' }, 400)
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: 'File too large' }, 413)

  const contentType = c.req.header('content-type') || guessContentType(key)

  await c.env.PHOTOS.put(`${prefix}orig/${key}`, bytes, { httpMetadata: { contentType } })

  // Some legacy uploads are actually Windows Metafiles (EMF) mislabeled with a .jpg
  // extension (a pre-existing data-quality issue from the original import pipeline, not
  // something Photon can decode). Don't fail the whole upload for those — fall back to
  // serving the original bytes as-is so /media/t500 still returns something.
  let thumbBytes: Uint8Array
  let thumbContentType = 'image/webp'
  let thumbnailed = true
  try {
    thumbBytes = makeThumbnail(bytes)
  } catch {
    thumbBytes = bytes
    thumbContentType = contentType
    thumbnailed = false
  }
  await c.env.PHOTOS.put(`${prefix}t500/${key}`, thumbBytes, { httpMetadata: { contentType: thumbContentType } })

  return c.json({ key, thumbnailed })
})
