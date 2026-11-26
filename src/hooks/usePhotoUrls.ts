import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function usePhotoUrls(paths: string[], enabled = true): Record<string, string> {
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const run = async () => {
      const missing = paths.filter((p) => !photoUrlByPath[p])
      if (!missing.length) return
      for (let i = 0; i < missing.length; i += 80) {
        if (cancelled) return
        const batch = missing.slice(i, i + 80)
        const { data } = await supabase.storage.from('voter-photos').createSignedUrls(batch, 3600)
        if (cancelled || !data) continue
        const next: Record<string, string> = {}
        for (let j = 0; j < batch.length; j++) {
          const url = data[j]?.signedUrl
          if (url) next[batch[j]] = url
        }
        if (Object.keys(next).length) setPhotoUrlByPath((c) => ({ ...c, ...next }))
      }
    }
    void run()
    return () => { cancelled = true }
  }, [paths, photoUrlByPath, enabled])

  return photoUrlByPath
}
