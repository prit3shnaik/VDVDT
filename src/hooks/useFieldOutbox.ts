import { useEffect, useState } from 'react'
import { pendingOutboxCount, startOutboxSync, subscribeOutbox } from '../lib/fieldOutbox'

export function useFieldOutboxCount(): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    startOutboxSync()
    let cancelled = false
    const refresh = () => {
      void pendingOutboxCount().then((n) => {
        if (!cancelled) setCount(n)
      })
    }
    refresh()
    const unsub = subscribeOutbox(refresh)
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  return count
}
