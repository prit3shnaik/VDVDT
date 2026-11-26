import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, type AuthedVars } from '../middleware/auth'
import { servePhoto } from '../lib/serve-photo'

export const media = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

// Serves R2 objects written by the photo upload pipeline (orig/ and t500/ only).
media.get('/media/:size/*', requireUser, async (c) => {
  const size = c.req.param('size') ?? ''
  const key = c.req.path.slice(`/media/${size}/`.length)
  return servePhoto(c, size, key)
})
