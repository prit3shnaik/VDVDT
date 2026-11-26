export const D1_IN_CHUNK = 80
export const D1_IN_WAVE = 6

export function chunksOf<T>(arr: T[], size: number = D1_IN_CHUNK): T[][] {
  const out: T[][] = []
  const step = Math.max(1, size)
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step))
  return out
}

export async function mapInChunks<T, R>(
  ids: T[],
  fn: (chunk: T[]) => Promise<R>,
  chunkSize: number = D1_IN_CHUNK,
  waveSize: number = D1_IN_WAVE,
): Promise<R[]> {
  const chunks = chunksOf(ids, chunkSize)
  const out: R[] = []
  for (let i = 0; i < chunks.length; i += waveSize) {
    const wave = chunks.slice(i, i + waveSize)
    const results = await Promise.all(wave.map((chunk) => fn(chunk)))
    out.push(...results)
  }
  return out
}

export async function fetchInChunks<T>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  chunkSize: number = D1_IN_CHUNK,
): Promise<T[]> {
  if (!ids.length) return []
  const rows: T[] = []
  await mapInChunks(ids, async (chunk) => {
    const { data, error } = await run(chunk)
    if (error) throw new Error(error.message)
    if (data?.length) rows.push(...data)
  }, chunkSize)
  return rows
}

export async function forEachInChunk<T>(
  ids: T[],
  fn: (chunk: T[]) => Promise<void>,
  chunkSize: number = D1_IN_CHUNK,
): Promise<void> {
  for (const chunk of chunksOf(ids, chunkSize)) {
    await fn(chunk)
  }
}

export async function fetchApiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init })
  const body = await res.json().catch(() => ({})) as { error?: string; message?: string }
  if (!res.ok) {
    throw new Error(body.error || body.message || `Request failed (${res.status})`)
  }
  return body as T
}
