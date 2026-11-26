import { idbGet, idbSet } from './idbCache'

export type FieldOutboxType = 'attendance' | 'geotag'

export interface FieldOutboxItem {
  type: FieldOutboxType
  event_id: string
  payload: Record<string, unknown>
  created_at: string
  tries: number
  last_error?: string
}

const QUEUE_KEY = 'field:outbox:v1'
const LISTENERS = new Set<() => void>()

function notify() {
  for (const listener of LISTENERS) listener()
}

export function subscribeOutbox(listener: () => void): () => void {
  LISTENERS.add(listener)
  return () => {
    LISTENERS.delete(listener)
  }
}

async function readQueue(): Promise<FieldOutboxItem[]> {
  return (await idbGet<FieldOutboxItem[]>(QUEUE_KEY)) ?? []
}

async function writeQueue(items: FieldOutboxItem[]): Promise<void> {
  await idbSet(QUEUE_KEY, items)
  notify()
}

export async function listOutbox(): Promise<FieldOutboxItem[]> {
  return readQueue()
}

export async function pendingOutboxCount(): Promise<number> {
  return (await readQueue()).length
}

export async function enqueueOutbox(item: Omit<FieldOutboxItem, 'tries' | 'created_at'> & { created_at?: string }): Promise<void> {
  const queue = await readQueue()
  if (queue.some((row) => row.event_id === item.event_id)) return
  queue.push({
    type: item.type,
    event_id: item.event_id,
    payload: item.payload,
    created_at: item.created_at ?? new Date().toISOString(),
    tries: 0,
  })
  await writeQueue(queue)
}

export async function removeOutbox(eventId: string): Promise<void> {
  const queue = await readQueue()
  const next = queue.filter((row) => row.event_id !== eventId)
  if (next.length === queue.length) return
  await writeQueue(next)
}

function endpointFor(type: FieldOutboxType): string {
  return type === 'attendance' ? '/api/booth/attendance' : '/api/field/geotags'
}

export async function flushOutbox(): Promise<{ flushed: number; remaining: number }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const remaining = (await readQueue()).length
    return { flushed: 0, remaining }
  }

  const queue = await readQueue()
  if (queue.length === 0) return { flushed: 0, remaining: 0 }

  let flushed = 0
  const kept: FieldOutboxItem[] = []

  for (const item of queue) {
    try {
      const res = await fetch(endpointFor(item.type), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload),
      })
      if (res.ok || res.status === 409) {
        flushed += 1
        continue
      }
      const body = await res.json().catch(() => ({})) as { error?: string }
      kept.push({
        ...item,
        tries: item.tries + 1,
        last_error: body.error || `HTTP ${res.status}`,
      })
    } catch {
      kept.push({ ...item, tries: item.tries + 1, last_error: 'offline' })
    }
  }

  await writeQueue(kept)
  return { flushed, remaining: kept.length }
}

let started = false

export function startOutboxSync(): void {
  if (started || typeof window === 'undefined') return
  started = true
  const run = () => {
    void flushOutbox()
  }
  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run()
  })
  window.setInterval(run, 15000)
  run()
}

export function newEventId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
