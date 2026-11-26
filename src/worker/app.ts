import { Hono } from 'hono'
import { createAuth } from './auth'
import { requireUser, type AuthedVars } from './middleware/auth'
import { photos } from './routes/photos'
import { media } from './routes/media'
import { voterDuplicates } from './routes/voter-duplicates'
import { voters } from './routes/voters'
import { dashboard } from './routes/dashboard'
import { customFields } from './routes/custom-fields'
import { activityLogs } from './routes/activity-logs'
import { groups } from './routes/groups'
import { teamLeaders } from './routes/team-leaders'
import { tenants } from './routes/tenants'
import { landlords } from './routes/landlords'
import { meetings } from './routes/meetings'
import { jobRecords } from './routes/job-records'
import { userManagement } from './routes/user-management'
import { authBootstrap } from './routes/auth-bootstrap'
import { importRoutes } from './routes/import'
import { rest } from './routes/rest'
import { storage } from './routes/storage'
import { shiftedBackup } from './routes/shifted-backup'
import { booth } from './routes/booth'
import { field } from './routes/field'
import type { Env } from './env'

export const app = new Hono<{ Bindings: Env; Variables: AuthedVars }>()

// Bootstrap endpoint (no session required; guarded by ADMIN_SETUP_PIN)
app.route('/', authBootstrap)

// SECURITY: Better Auth exposes public self-registration by default. Accounts here are
// created by an admin (or by bootstrap), never by strangers, so the public sign-up and
// password-reset endpoints are closed off. Server-side calls to auth.api.signUpEmail
// are unaffected — this only blocks the HTTP route.
app.all('/api/auth/sign-up/*', (c) => c.json({ error: 'Not found' }, 404))
app.all('/api/auth/forget-password/*', (c) => c.json({ error: 'Not found' }, 404))
app.all('/api/auth/reset-password/*', (c) => c.json({ error: 'Not found' }, 404))

// Better Auth owns everything under /api/auth/* (sign-in, sign-out, session, etc).
app.on(['GET', 'POST'], '/api/auth/*', (c) => {
  const auth = createAuth(c.env)
  return auth.handler(c.req.raw)
})

// Joins the Better Auth session to the app's `users` profile row.
app.get('/api/me', requireUser, (c) => {
  return c.json({ user: c.get('authUser'), profile: c.get('profile') })
})

app.route('/', photos)
app.route('/', media)
app.route('/', voterDuplicates)
app.route('/', voters)
app.route('/', dashboard)
app.route('/', customFields)
app.route('/', activityLogs)
app.route('/', groups)
app.route('/', teamLeaders)
app.route('/', tenants)
app.route('/', landlords)
app.route('/', meetings)
app.route('/', jobRecords)
app.route('/', userManagement)
app.route('/', importRoutes)
app.route('/', rest)
app.route('/', storage)
app.route('/', shiftedBackup)
app.route('/', booth)
app.route('/', field)

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal error' }, 500)
})
