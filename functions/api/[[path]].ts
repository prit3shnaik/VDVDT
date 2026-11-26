import { app } from '../../src/worker/app'
import type { Env } from '../../src/worker/env'

interface PagesContext {
  request: Request
  env: Env
}

export const onRequest = (context: PagesContext) => {
  return app.fetch(context.request, context.env)
}
