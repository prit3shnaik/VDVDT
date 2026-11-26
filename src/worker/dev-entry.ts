import { app } from './app'

// Plain Worker entry for `wrangler dev` during local development.
// Production uses the Pages Functions entry at functions/api/[[path]].ts instead.
export default app
