import type { Context } from 'hono'
import type { Env } from '../env'
import type { AuthedVars } from '../middleware/auth'

export type PhotoSize = 'orig' | 't500'

export function isPhotoSize(value: string): value is PhotoSize {
  return value === 'orig' || value === 't500'
}

/**
 * Streams a photo object out of R2.
 *
 * Cache-Control is `private` (browser cache only, never shared/CDN) because access is
 * gated by session + ward ACL — a public or CDN cache would let the image be served to
 * someone else on a cache hit, bypassing that check.
 */
export async function servePhoto(
  c: Context<{ Bindings: Env; Variables: AuthedVars }>,
  size: string,
  key: string
): Promise<Response> {
  if (!isPhotoSize(size)) {
    return c.json({ error: 'Invalid size' }, 400)
  }

  const cleanKey = key.replace(/^\/+/, '')
  if (!cleanKey) {
    return c.json({ error: 'Missing key' }, 400)
  }

  const object = await c.env.PHOTOS.get(`${size}/${cleanKey}`)
  if (!object) {
    return c.json({ error: 'Not found' }, 404)
  }

  return c.body(object.body as unknown as ReadableStream, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
      ETag: object.httpEtag,
    },
  })
}
