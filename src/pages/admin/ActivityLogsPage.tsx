import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../../components/common/PageHeader'
import { supabase } from '../../lib/supabase'
import { FAST_NAV_CACHE_MAX_AGE_MS, readCachedCollection, writeCachedCollection } from '../../lib/voterCache'

const ACTIVITY_LOGS_CACHE_KEY = 'vote:admin:activity-logs'
const ACTIVITY_ACTORS_CACHE_KEY = 'vote:admin:activity-actors'

interface ActivityLog {
  id: string
  actor_user_id: string | null
  action: string
  target_table: string
  target_id: string | null
  created_at: string
  details: Record<string, unknown> | null
}

export function ActivityLogsPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [actorNameById, setActorNameById] = useState<Record<string, string>>({})
  const [actionFilter, setActionFilter] = useState('all')
  const [tableFilter, setTableFilter] = useState('all')
  const [actorFilter, setActorFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  useEffect(() => {
    const cachedLogs = readCachedCollection<ActivityLog>(ACTIVITY_LOGS_CACHE_KEY, 'global', FAST_NAV_CACHE_MAX_AGE_MS)
    if (cachedLogs) {
      setLogs(cachedLogs)
    }

    const cachedActors = readCachedCollection<{ id: string; name: string }>(ACTIVITY_ACTORS_CACHE_KEY, 'global', FAST_NAV_CACHE_MAX_AGE_MS)
    if (cachedActors?.length) {
      const mapping: Record<string, string> = {}
      for (const actor of cachedActors) {
        mapping[actor.id] = actor.name
      }
      setActorNameById(mapping)
    }
  }, [])

  useEffect(() => {
    supabase
      .from('activity_logs')
      .select('id,actor_user_id,action,target_table,target_id,created_at,details')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        const rows = (data as ActivityLog[] | null) ?? []
        setLogs(rows)
        writeCachedCollection<ActivityLog>(ACTIVITY_LOGS_CACHE_KEY, 'global', rows)

        const actorIds = Array.from(new Set(rows.map((log) => log.actor_user_id).filter((value): value is string => Boolean(value))))
        if (!actorIds.length) {
          setActorNameById({})
          return
        }

        supabase
          .from('users')
          .select('id,full_name,email')
          .in('id', actorIds)
          .then(({ data: actors }) => {
            const mapping: Record<string, string> = {}
            for (const actor of (actors as Array<{ id: string; full_name: string | null; email: string }> | null) ?? []) {
              mapping[actor.id] = actor.full_name?.trim() || actor.email
            }
            setActorNameById(mapping)
            const actorRows = Object.entries(mapping).map(([id, name]) => ({ id, name }))
            writeCachedCollection<{ id: string; name: string }>(ACTIVITY_ACTORS_CACHE_KEY, 'global', actorRows)
          })
      })
  }, [])

  const describeAction = (log: ActivityLog): string => {
    const table = log.target_table || 'record'
    const target = log.target_id ? ` (${log.target_id})` : ''
    switch (log.action) {
      case 'admin_create_user':
        return `Created a user account${target}`
      case 'admin_reset_password':
        return `Reset a user password${target}`
      case 'bootstrap_admin':
        return 'Bootstrapped initial admin access'
      case 'login':
        return 'Logged in'
      case 'create':
        return `Created ${table}${target}`
      case 'update':
        return `Updated ${table}${target}`
      case 'delete':
        return `Deleted ${table}${target}`
      default:
        return `${log.action} on ${table}${target}`
    }
  }

  const actionOptions = useMemo(
    () => ['all', ...Array.from(new Set(logs.map((log) => log.action))).sort((a, b) => a.localeCompare(b))],
    [logs],
  )

  const tableOptions = useMemo(
    () => ['all', ...Array.from(new Set(logs.map((log) => log.target_table))).sort((a, b) => a.localeCompare(b))],
    [logs],
  )

  const filteredLogs = useMemo(
    () =>
      logs.filter((log) => {
        if (actionFilter !== 'all' && log.action !== actionFilter) {
          return false
        }

        if (tableFilter !== 'all' && log.target_table !== tableFilter) {
          return false
        }

        if (actorFilter.trim()) {
          const lowered = actorFilter.trim().toLowerCase()
          const actorText = log.actor_user_id ? (actorNameById[log.actor_user_id] ?? log.actor_user_id).toLowerCase() : 'system'
          const targetText = (log.target_id ?? '').toLowerCase()
          if (!actorText.includes(lowered) && !targetText.includes(lowered)) {
            const details = JSON.stringify(log.details ?? {}).toLowerCase()
            if (!details.includes(lowered)) {
              return false
            }
          }
        }

        const logDate = new Date(log.created_at)
        if (fromDate) {
          const from = new Date(`${fromDate}T00:00:00`)
          if (logDate < from) {
            return false
          }
        }

        if (toDate) {
          const to = new Date(`${toDate}T23:59:59`)
          if (logDate > to) {
            return false
          }
        }

        return true
      }),
    [actionFilter, tableFilter, actorFilter, fromDate, toDate, logs, actorNameById],
  )

  return (
    <div>
      <PageHeader title="Activity Logs" description="Full audit log with before/after diffs and actor context." />

      <section className="mb-4 grid gap-3 rounded-xl border border-line bg-white p-4 md:grid-cols-5">
        <select
          className="h-11 rounded-xl border border-line px-3 text-sm"
          value={actionFilter}
          aria-label="Filter logs by action"
          title="Filter logs by action"
          onChange={(event) => setActionFilter(event.target.value)}
        >
          {actionOptions.map((action) => (
            <option key={action} value={action}>
              {action === 'all' ? 'All actions' : action}
            </option>
          ))}
        </select>
        <select
          className="h-11 rounded-xl border border-line px-3 text-sm"
          value={tableFilter}
          aria-label="Filter logs by table"
          title="Filter logs by table"
          onChange={(event) => setTableFilter(event.target.value)}
        >
          {tableOptions.map((table) => (
            <option key={table} value={table}>
              {table === 'all' ? 'All tables' : table}
            </option>
          ))}
        </select>
        <input
          className="h-11 rounded-xl border border-line px-3 text-sm"
          placeholder="Actor / target / details"
          value={actorFilter}
          aria-label="Search logs by actor or target"
          title="Search logs by actor or target"
          onChange={(event) => setActorFilter(event.target.value)}
        />
        <input
          className="h-11 rounded-xl border border-line px-3 text-sm"
          type="date"
          value={fromDate}
          aria-label="From date"
          title="From date"
          onChange={(event) => setFromDate(event.target.value)}
        />
        <input
          className="h-11 rounded-xl border border-line px-3 text-sm"
          type="date"
          value={toDate}
          aria-label="To date"
          title="To date"
          onChange={(event) => setToDate(event.target.value)}
        />
      </section>

      <section className="rounded-xl border border-line bg-white p-4">
        <ul className="divide-y divide-line text-sm">
          {filteredLogs.map((log) => (
            <li key={log.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
              <div>
                <p className="font-medium text-ink">{describeAction(log)}</p>
                <p className="text-ink-tertiary">
                  {new Date(log.created_at).toLocaleString()} · actor: {log.actor_user_id ? actorNameById[log.actor_user_id] ?? log.actor_user_id : 'System'} · table: {log.target_table}
                </p>
              </div>
              <span className="inline-flex rounded-full border border-line bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-secondary">
                {log.action}
              </span>
            </li>
          ))}
        </ul>
        {!filteredLogs.length ? <p className="py-4 text-sm text-ink-tertiary">No activity matched selected filters.</p> : null}
      </section>
    </div>
  )
}
