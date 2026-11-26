import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Navigation } from 'lucide-react'
import toast from 'react-hot-toast'
import { PageHeader } from '../../components/common/PageHeader'
import { LeafletMap } from '../../components/field/LeafletMap'
import { useAuth } from '../../hooks/useAuth'
import { fetchApiJson } from '../../lib/d1Query'
import type { FamilyGeotag } from '../../lib/types'

interface UntaggedRow {
  family_key: string
  head_name: string | null
  house_no: string | null
  part_no: number | null
}

interface MemberRow {
  id: string
  name: string
  epic_no: string
  age: number | null
  gender: string | null
}

export function FieldMapPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin' || profile?.role === 'sub-admin'
  const [geotags, setGeotags] = useState<FamilyGeotag[]>([])
  const [untaggedCount, setUntaggedCount] = useState(0)
  const [partNo, setPartNo] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [untagged, setUntagged] = useState<UntaggedRow[]>([])

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (partNo) qs.set('part_no', partNo)
      const [tags, um] = await Promise.all([
        fetchApiJson<{ geotags: FamilyGeotag[] }>(`/api/field/geotags?${qs}`),
        fetchApiJson<{ untagged: UntaggedRow[]; count: number }>('/api/field/geotags/untagged'),
      ])
      setGeotags(tags.geotags)
      setUntaggedCount(um.count)
      setUntagged(um.untagged)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load map')
    }
  }, [partNo])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedKey) {
      setMembers([])
      return
    }
    void fetchApiJson<{ members: MemberRow[] }>(`/api/field/geotags/${encodeURIComponent(selectedKey)}/members`)
      .then((data) => setMembers(data.members))
      .catch(() => setMembers([]))
  }, [selectedKey])

  const pins = useMemo(
    () =>
      geotags.map((g) => ({
        id: g.family_key,
        lat: g.lat,
        lng: g.lng,
        label: g.head_name || g.family_key,
      })),
    [geotags],
  )

  const parts = Array.from(new Set(geotags.map((g) => g.part_no).filter((n): n is number => n != null))).sort((a, b) => a - b)
  const selected = geotags.find((g) => g.family_key === selectedKey) ?? null

  const clearPin = async () => {
    if (!selectedKey || !isAdmin) return
    try {
      await fetchApiJson(`/api/field/geotags/${encodeURIComponent(selectedKey)}`, { method: 'DELETE' })
      toast.success('Pin cleared')
      setSelectedKey(null)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to clear')
    }
  }

  return (
    <div>
      <PageHeader
        title="Family map"
        description="Mormugao street and satellite map. Tagged house pins only. Untagged families stay off the map."
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select className="h-11 rounded-xl border border-line bg-white px-3" value={partNo} onChange={(e) => setPartNo(e.target.value)}>
          <option value="">All parts</option>
          {parts.map((p) => (
            <option key={p} value={String(p)}>Part {p}</option>
          ))}
        </select>
        <span className="rounded-full bg-muted px-3 py-1 text-sm font-semibold text-ink-secondary">
          {geotags.length} tagged
        </span>
        <span className="rounded-full border border-[var(--warning-border)] bg-[var(--warning-fill)] px-3 py-1 text-sm font-semibold text-[var(--warning)]">
          {untaggedCount} untagged
        </span>
      </div>

      <LeafletMap pins={pins} height="28rem" selectedId={selectedKey} onPinClick={setSelectedKey} />
      {geotags.length === 0 ? (
        <p className="mt-2 text-sm text-ink-tertiary">
          Mormugao street and satellite map. No house pins yet — tag families from Geo-tag first.
        </p>
      ) : null}

      {selected ? (
        <section className="mt-4 rounded-xl border border-line bg-white p-4">
          <p className="font-semibold text-ink">{selected.head_name || selected.family_key}</p>
          <p className="text-sm text-ink-secondary">
            H {selected.house_no ?? '-'} · Part {selected.part_no ?? '-'} ·{' '}
            {selected.accuracy_m != null ? `accuracy ±${Math.round(selected.accuracy_m)} m` : 'manual pin'}
          </p>
          <p className="mt-2 text-sm text-ink-secondary">{selected.address?.trim() || 'Address unavailable'}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={`https://www.google.com/maps?q=${selected.lat},${selected.lng}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line px-3 text-sm font-semibold text-brand-700"
            >
              <ExternalLink className="h-4 w-4" /> Open in Google Maps
            </a>
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${selected.lat},${selected.lng}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line px-3 text-sm font-semibold text-brand-700"
            >
              <Navigation className="h-4 w-4" /> Directions
            </a>
          </div>
          <div className="mt-3 space-y-1 text-sm">
            {members.map((m) => (
              <p key={m.id} className="flex justify-between border-t border-line py-1">
                <span>{m.name}</span>
                <span className="text-ink-tertiary">{m.epic_no}</span>
              </p>
            ))}
          </div>
          {isAdmin ? (
            <button
              type="button"
              className="mt-3 h-11 w-full rounded-xl border border-rose-200 text-sm font-semibold text-rose-700"
              onClick={() => void clearPin()}
            >
              Clear current pin
            </button>
          ) : null}
        </section>
      ) : null}

      {untagged.length > 0 ? (
        <section className="mt-4 rounded-xl border border-line bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">Untagged sample</h2>
          {untagged.slice(0, 20).map((row) => (
            <p key={row.family_key} className="flex justify-between py-1 text-sm">
              <span>{row.head_name || row.family_key}</span>
              <span className="text-ink-tertiary">H {row.house_no ?? '-'}</span>
            </p>
          ))}
        </section>
      ) : null}
    </div>
  )
}
