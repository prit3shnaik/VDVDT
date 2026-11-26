import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

function readValue<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') {
    return fallback
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) {
      return fallback
    }

    try {
      return JSON.parse(raw) as T
    } catch {
      // Backward compatibility for older keys stored as raw strings.
      if (typeof fallback === 'string') {
        return raw as T
      }
      return fallback
    }
  } catch {
    return fallback
  }
}

export function usePersistentState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readValue(key, fallback))

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Ignore storage write errors (quota/private mode).
    }
  }, [key, value])

  return [value, setValue]
}
