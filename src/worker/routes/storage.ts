import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, type AuthedVars } from '../middleware/auth'
import { servePhoto } from '../lib/serve-photo'

export const storage = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

/**
 * Supabase Storage-compatible shim.
 *
 * Many pages call `supabase.storage.from('voter-photos').createSignedUrl(s)`. R2 objects
 * here are served by the auth-gated photo route instead, so there is no token to mint:
 * we return a path and access stays gated by the session cookie on the follow-up request.
 *
 * IMPORTANT: supabase-js builds the final URL as `${supabaseUrl}/storage/v1` + whatever
 * `signedURL` we return. So the returned path must resolve *relative to /storage/v1*,
 * which is why the photo bytes are also mounted at /storage/v1/media/... below.
 */

const PHOTO_BUCKET = 'voter-photos'
const UPLOAD_BUCKET = 'import-temp'

function signedPathFor(key: string, size: 't500' | 'orig' = 't500'): string {
  return `/media/${size}/${key.replace(/^\/+/, '')}`
}

// Photo bytes, reachable at the URL supabase-js constructs.
storage.get('/storage/v1/media/:size/*', requireUser, async (c) => {
  const size = c.req.param('size') ?? ''
  const key = c.req.path.slice(`/storage/v1/media/${size}/`.length)
  return servePhoto(c, size, key)
})

// createSignedUrls (batch). Registered BEFORE the single-object route below, because
// the wildcard route also matches this path with an empty remainder.
storage.post('/storage/v1/object/sign/:bucket', requireUser, async (c) => {
  if (c.req.param('bucket') !== PHOTO_BUCKET) {
    return c.json({ message: 'Unknown bucket' }, 400)
  }

  const { paths } = await c.req.json<{ paths?: string[] }>()
  if (!Array.isArray(paths)) {
    return c.json({ message: 'paths is required' }, 400)
  }

  return c.json(
    paths.map((path) => ({
      path,
      signedURL: signedPathFor(path),
      error: null,
    }))
  )
})

// createSignedUrl (single object).
storage.post('/storage/v1/object/sign/:bucket/*', requireUser, async (c) => {
  const bucket = c.req.param('bucket')
  if (bucket !== PHOTO_BUCKET) {
    return c.json({ message: 'Unknown bucket' }, 400)
  }

  const key = c.req.path.slice(`/storage/v1/object/sign/${bucket}/`.length)
  if (!key) {
    return c.json({ message: 'Missing object path' }, 400)
  }

  return c.json({ signedURL: signedPathFor(key) })
})

// upload (used by the import flow for raw xlsx files).
storage.post('/storage/v1/object/:bucket/*', requireUser, async (c) => {
  const profile = c.get('profile')
  if (profile.role !== 'admin' && profile.role !== 'sub-admin') {
    return c.json({ message: 'Forbidden' }, 403)
  }

  const bucket = c.req.param('bucket')
  if (bucket !== UPLOAD_BUCKET) {
    return c.json({ message: 'Unknown bucket' }, 400)
  }

  const key = c.req.path.slice(`/storage/v1/object/${bucket}/`.length)
  if (!key) {
    return c.json({ message: 'Missing object path' }, 400)
  }

  const { bytes, contentType } = await readUploadBytes(c.req.raw)
  await c.env.IMPORT_TEMP.put(key, bytes, {
    httpMetadata: {
      contentType,
    },
  })

  return c.json({ Key: `${bucket}/${key}` })
})

async function readUploadBytes(request: Request): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const headerType = request.headers.get('content-type') ?? ''
  if (headerType.toLowerCase().includes('multipart/form-data')) {
    const form = await request.formData()
    for (const value of form.values()) {
      // FormDataEntryValue is `string | File`; anything that isn't a string is the file.
      // (The old `instanceof File || instanceof Blob` made TS narrow `value` to `string`
      // on the right-hand side, which caused TS2358.)
      if (typeof value !== 'string') {
        const file = value as Blob
        return {
          bytes: await file.arrayBuffer(),
          contentType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }
      }
    }
  }

  return {
    bytes: await request.arrayBuffer(),
    contentType: headerType || 'application/octet-stream',
  }
}
