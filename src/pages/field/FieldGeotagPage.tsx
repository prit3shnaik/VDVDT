import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, ExternalLink, MapPin, Navigation, WifiOff } from 'lucide-react'
import toast from 'react-hot-toast'
import { PageHeader } from '../../components/common/PageHeader'
import { LeafletMap, MORMUGAO_BOUNDS, MORMUGAO_CENTER } from '../../components/field/LeafletMap'
import { useAuth } from '../../hooks/useAuth'
import { useFieldOutboxCount } from '../../hooks/useFieldOutbox'
import { loadAllVoters } from '../../lib/voterDataset'
import { enqueueOutbox, flushOutbox, newEventId, startOutboxSync } from '../../lib/fieldOutbox'
import { fetchApiJson } from '../../lib/d1Query'
import { tokenizeLookup, matchesLookupTokens, normalizeLookupValue } from '../../lib/searchUtils'
import { familyHeadKeyOf } from '../../lib/teamLeaderCache'
import type { FamilyGeotag, Voter } from '../../lib/types'

interface FamilyRow {
  key: string
  head: Voter | null
  members: Voter[]
}

interface LeaderLink {
  team_leader_id: string
  display_name: string | null
  part_no: number | null
  section: number | null
}

interface GpsFix {
  lat: number
  lng: number
  accuracy: number | null
  altitude: number | null
  source: 'gps' | 'manual'
}

const ACCURACY_LIMIT = 50
const TARGET_ACCURACY = 12
const WATCH_DEADLINE_MS = 25000

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)))
}

function gpsErrorMessage(err?: GeolocationPositionError): string {
  if (!navigator.geolocation) return 'GPS is not available. Tap the map to drop a pin.'
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Location needs HTTPS. Tap the map to drop a pin.'
  }
  if (!err) return 'Could not get GPS position. Tap the map to drop a pin.'
  if (err.code === 1) return 'Location permission denied. Allow location for this site, or tap the map.'
  if (err.code === 2) return 'GPS unavailable. Move outdoors, or tap the map to drop a pin.'
  if (err.code === 3) return 'GPS timed out. Try again, or tap the map to drop a pin.'
  return 'Could not get GPS position. Tap the map to drop a pin.'
}

function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

function directionsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
}

export function FieldGeotagPage() {
  const { profile } = useAuth()
  const pending = useFieldOutboxCount()
  const isAdmin = profile?.role === 'admin' || profile?.role === 'sub-admin'
  const [voters, setVoters] = useState<Voter[]>([])
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set())
  const [leaders, setLeaders] = useState<LeaderLink[]>([])
  const [geotags, setGeotags] = useState<Record<string, FamilyGeotag>>({})
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [fix, setFix] = useState<GpsFix | null>(null)
  const [locating, setLocating] = useState(false)
  const [address, setAddress] = useState<string | null>(null)
  const [addressLoading, setAddressLoading] = useState(false)
  const [forceSave, setForceSave] = useState(false)
  const [note, setNote] = useState('')
  const watchIdRef = useRef<number | null>(null)
  const watchTimerRef = useRef<number | null>(null)
  const watchActiveRef = useRef(false)
  const bestFixRef = useRef<GpsFix | null>(null)
  const geocodeSeqRef = useRef(0)
  const geocodeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    startOutboxSync()
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const [scope, tags, rows] = await Promise.all([
          fetchApiJson<{ leaders: LeaderLink[]; assigned_voter_ids: string[]; admin: boolean }>('/api/field/scope'),
          fetchApiJson<{ geotags: FamilyGeotag[] }>('/api/field/geotags'),
          loadAllVoters({ role: profile?.role, allowedWards: profile?.allowed_wards }),
        ])
        if (cancelled) return
        setLeaders(scope.leaders ?? [])
        setAssignedIds(new Set(scope.assigned_voter_ids ?? []))
        const map: Record<string, FamilyGeotag> = {}
        for (const tag of tags.geotags) map[tag.family_key] = tag
        setGeotags(map)
        setVoters(rows)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load families')
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [profile?.role, profile?.allowed_wards])

  const families = useMemo(() => {
    const scoped = isAdmin && assignedIds.size === 0
      ? voters
      : voters.filter((v) => assignedIds.has(v.id))
    const groups = new Map<string, Voter[]>()
    for (const voter of scoped) {
      const key = familyHeadKeyOf(voter)
      if (!key) continue
      const list = groups.get(key)
      if (list) list.push(voter)
      else groups.set(key, [voter])
    }
    const rows: FamilyRow[] = []
    for (const [key, members] of groups) {
      const head = members.find((m) => m.epic_no.trim() === key) ?? members[0] ?? null
      rows.push({ key, head, members })
    }
    rows.sort((a, b) => (a.head?.name ?? a.key).localeCompare(b.head?.name ?? b.key))
    return rows
  }, [voters, assignedIds, isAdmin])

  const tokens = useMemo(() => tokenizeLookup(query), [query])
  const filtered = useMemo(() => {
    if (!tokens.length) return families
    return families.filter((family) => {
      const text = normalizeLookupValue(
        [family.key, family.head?.name, family.head?.house_no, family.head?.epic_no, ...family.members.map((m) => m.name)]
          .filter(Boolean)
          .join(' '),
      )
      return matchesLookupTokens(text, tokens)
    })
  }, [families, tokens])

  const selected = families.find((f) => f.key === selectedKey) ?? null
  const selectedTag = selectedKey ? geotags[selectedKey] : null
  const poor = fix?.accuracy != null && fix.accuracy > ACCURACY_LIMIT

  const stopWatch = useCallback(() => {
    watchActiveRef.current = false
    if (watchIdRef.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    if (watchTimerRef.current != null) {
      window.clearTimeout(watchTimerRef.current)
      watchTimerRef.current = null
    }
  }, [])

  const cancelGeocode = useCallback(() => {
    if (geocodeTimerRef.current != null) {
      window.clearTimeout(geocodeTimerRef.current)
      geocodeTimerRef.current = null
    }
    geocodeSeqRef.current += 1
    setAddressLoading(false)
  }, [])

  const reverseGeocode = useCallback((lat: number, lng: number, debounceMs = 0): Promise<string | null> => {
    if (geocodeTimerRef.current != null) {
      window.clearTimeout(geocodeTimerRef.current)
      geocodeTimerRef.current = null
    }
    const seq = ++geocodeSeqRef.current
    setAddressLoading(true)
    const run = () => fetchApiJson<{ address: string | null }>(`/api/field/geocode?lat=${lat}&lng=${lng}`)
      .then((data) => {
        const next = data.address?.trim() || null
        if (seq === geocodeSeqRef.current) setAddress(next)
        return next
      })
      .catch(() => {
        if (seq === geocodeSeqRef.current) setAddress(null)
        return null
      })
      .finally(() => {
        if (seq === geocodeSeqRef.current) setAddressLoading(false)
      })
    const promise = new Promise<string | null>((resolve) => {
      if (debounceMs > 0) {
        geocodeTimerRef.current = window.setTimeout(() => {
          geocodeTimerRef.current = null
          void run().then(resolve)
        }, debounceMs)
      } else {
        void run().then(resolve)
      }
    })
    return promise
  }, [])

  const freezeFix = useCallback((candidate: GpsFix | null) => {
    if (!watchActiveRef.current) return
    stopWatch()
    setLocating(false)
    if (!candidate) {
      toast.error(gpsErrorMessage(undefined))
      return
    }
    if (!MORMUGAO_BOUNDS.contains([candidate.lat, candidate.lng])) {
      setFix(null)
      setAddress(null)
      setForceSave(false)
      toast.error('Pin is outside Mormugao bounds. Move closer or tap inside the map.')
      return
    }
    setFix(candidate)
    setAddress(null)
    void reverseGeocode(candidate.lat, candidate.lng)
  }, [reverseGeocode, stopWatch])

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      toast.error(gpsErrorMessage(undefined))
      return
    }
    stopWatch()
    cancelGeocode()
    bestFixRef.current = null
    setFix(null)
    setAddress(null)
    setForceSave(false)
    setLocating(true)
    watchActiveRef.current = true
    const startedAt = Date.now()
    watchTimerRef.current = window.setTimeout(() => freezeFix(bestFixRef.current), WATCH_DEADLINE_MS)
    try {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          if (!watchActiveRef.current) return
          const candidate: GpsFix = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
            altitude: pos.coords.altitude,
            source: 'gps',
          }
          if (!MORMUGAO_BOUNDS.contains([candidate.lat, candidate.lng])) {
            freezeFix(candidate)
            return
          }
          const best = bestFixRef.current
          if (!best || (candidate.accuracy ?? Infinity) < (best.accuracy ?? Infinity)) {
            bestFixRef.current = candidate
          }
          setFix(candidate)
          if ((candidate.accuracy ?? Infinity) <= TARGET_ACCURACY || Date.now() - startedAt >= WATCH_DEADLINE_MS) {
            freezeFix(bestFixRef.current)
          }
        },
        (err) => {
          if (!watchActiveRef.current) return
          if (bestFixRef.current) {
            freezeFix(bestFixRef.current)
          } else {
            stopWatch()
            setLocating(false)
            toast.error(gpsErrorMessage(err))
          }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      )
    } catch {
      stopWatch()
      setLocating(false)
      toast.error(gpsErrorMessage(undefined))
    }
  }, [cancelGeocode, freezeFix, stopWatch])

  const dropMapPin = useCallback((lat: number, lng: number) => {
    const wasLocating = watchActiveRef.current
    stopWatch()
    setLocating(false)
    if (!MORMUGAO_BOUNDS.contains([lat, lng])) {
      toast.error('Pin is outside Mormugao bounds. Tap inside the map.')
      if (wasLocating) {
        cancelGeocode()
        setFix(null)
        setAddress(null)
      }
      return
    }
    setFix({ lat, lng, accuracy: null, altitude: null, source: 'manual' })
    setAddress(null)
    setForceSave(false)
    void reverseGeocode(lat, lng, 400)
  }, [cancelGeocode, reverseGeocode, stopWatch])

  const resetSheet = useCallback(() => {
    stopWatch()
    cancelGeocode()
    setSelectedKey(null)
    setFix(null)
    setAddress(null)
    setForceSave(false)
    setNote('')
    setLocating(false)
  }, [cancelGeocode, stopWatch])

  const openFamily = useCallback((key: string) => {
    stopWatch()
    cancelGeocode()
    setSelectedKey(key)
    setFix(null)
    setAddress(null)
    setForceSave(false)
    setNote('')
    setLocating(false)
  }, [cancelGeocode, stopWatch])

  useEffect(() => () => {
    stopWatch()
    if (geocodeTimerRef.current != null) {
      window.clearTimeout(geocodeTimerRef.current)
      geocodeTimerRef.current = null
    }
    geocodeSeqRef.current += 1
  }, [stopWatch])

  const mapPins = useMemo(() => {
    if (fix) {
      return [{
        id: 'fix',
        lat: fix.lat,
        lng: fix.lng,
        label: fix.source === 'gps' ? 'GPS fix' : 'Map pin',
      }]
    }
    if (selectedTag) {
      return [{
        id: selectedTag.family_key,
        lat: selectedTag.lat,
        lng: selectedTag.lng,
        label: 'Current pin',
      }]
    }
    return []
  }, [fix, selectedTag])

  const mapCenter = useMemo<[number, number]>(() => {
    if (fix) return [fix.lat, fix.lng]
    if (selectedTag) return [selectedTag.lat, selectedTag.lng]
    return MORMUGAO_CENTER
  }, [fix, selectedTag])

  const accuracyCircle = useMemo(
    () => (fix?.source === 'gps' && fix.accuracy != null
      ? { lat: fix.lat, lng: fix.lng, radiusM: fix.accuracy }
      : null),
    [fix],
  )

  const savePin = async () => {
    if (!selected || !fix) return
    if (poor && !forceSave) {
      toast.error(`Accuracy is ${Math.round(fix.accuracy ?? 0)}m. Confirm save anyway.`)
      return
    }
    const resolvedAddress = address ?? (await reverseGeocode(fix.lat, fix.lng))
    const eventId = newEventId()
    const payload = {
      event_id: eventId,
      family_key: selected.key,
      voter_id: selected.head?.id ?? selected.members[0]?.id,
      lat: fix.lat,
      lng: fix.lng,
      accuracy_m: fix.accuracy,
      altitude: fix.altitude,
      address: resolvedAddress,
      source: fix.source,
      note: note.trim() || null,
      force: poor,
    }
    const optimistic: FamilyGeotag = {
      family_key: selected.key,
      lat: fix.lat,
      lng: fix.lng,
      accuracy_m: fix.accuracy,
      altitude: fix.altitude,
      tagged_at: new Date().toISOString(),
      tagged_by: profile?.id ?? '',
      team_leader_id: leaders[0]?.team_leader_id ?? null,
      source: fix.source,
      note: note.trim() || null,
      address: resolvedAddress,
      client_event_id: eventId,
      place_club_id: null,
      updated_at: new Date().toISOString(),
    }
    setGeotags((cur) => ({ ...cur, [selected.key]: optimistic }))
    await enqueueOutbox({ type: 'geotag', event_id: eventId, payload })
    toast.success('House pin saved')
    resetSheet()
    void flushOutbox()
  }

  const accuracyLabel = fix?.accuracy != null ? `±${Math.round(fix.accuracy)} m` : null

  return (
    <div>
      <PageHeader
        title="Family geo-tag"
        description="Stand outside the house, wait until the ring shrinks, then tag."
        action={
          pending > 0 ? (
            <span className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--warning-border)] bg-[var(--warning-fill)] px-3 text-sm font-semibold text-[var(--warning)]">
              <WifiOff className="h-4 w-4" />
              {pending} pending sync
            </span>
          ) : null
        }
      />

      {!isAdmin && leaders.length === 0 ? (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No team-leader assignment. Ask an admin to link your account.
        </p>
      ) : null}

      <input
        type="search"
        className="mb-4 h-14 w-full rounded-xl border border-line bg-white px-4 text-lg"
        placeholder="Search family, house, EPIC"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="space-y-2">
        {filtered.slice(0, 80).map((family) => {
          const tag = geotags[family.key]
          const dist = tag && fix ? Math.round(distanceM(fix, tag)) : null
          return (
            <button
              key={family.key}
              type="button"
              onClick={() => openFamily(family.key)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-white p-4 text-left"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{family.head?.name ?? family.key}</p>
                <p className="text-sm text-ink-secondary">
                  H {family.head?.house_no ?? '-'} · Part {family.head?.part_no ?? '-'} · Sec {family.head?.section ?? '-'}
                </p>
                <p className="text-xs text-ink-tertiary">{family.members.length} members</p>
              </div>
              {tag ? (
                <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
                  Tagged{dist != null ? ` · ${dist}m` : ''}
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs font-semibold text-ink-secondary">Not tagged</span>
              )}
            </button>
          )
        })}
      </div>

      {selected ? (
        <div className="fixed inset-0 z-50">
          <button type="button" className="absolute inset-0 bg-slate-900/40" onClick={resetSheet} aria-label="Close" />
          <div className="absolute inset-x-0 bottom-0 max-h-[92vh] overflow-y-auto rounded-t-xl border-t border-line bg-white p-5 pb-8">
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-muted" />
            <p className="text-lg font-semibold text-ink">{selected.head?.name ?? selected.key}</p>
            <p className="text-sm text-ink-secondary">
              {selected.key} · H {selected.head?.house_no ?? '-'} · {selected.members.length} members
            </p>

            <button
              type="button"
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-line bg-muted font-semibold"
              onClick={locate}
              disabled={locating}
            >
              <Crosshair className="h-4 w-4" /> {locating ? 'Finding GPS...' : 'Read GPS'}
            </button>

            <p className="mt-3 text-sm text-ink-tertiary">
              Stand outside the house, wait until the ring shrinks, then tag. GPS is best; tap the map only if needed.
            </p>
            <div className="mt-3">
              <LeafletMap
                pins={mapPins}
                center={mapCenter}
                zoom={fix || selectedTag ? 19 : 18}
                height="22rem"
                defaultLayer="satellite"
                onMapClick={dropMapPin}
                accuracyCircle={accuracyCircle}
              />
            </div>

            {locating ? (
              <p className="mt-3 text-sm font-semibold text-brand-700">
                {accuracyLabel ? `Live accuracy ${accuracyLabel}` : 'Waiting for GPS...'}
                {fix?.accuracy != null && fix.accuracy > TARGET_ACCURACY ? ' · hold still, improving' : ''}
              </p>
            ) : fix?.accuracy != null ? (
              <p className="mt-3 text-sm text-ink-secondary">
                Accuracy {accuracyLabel}
                {fix.accuracy > ACCURACY_LIMIT ? ' (poor — confirm to save anyway)' : ''}
              </p>
            ) : fix?.source === 'manual' ? (
              <p className="mt-3 text-sm text-ink-secondary">Map pin (manual). GPS gives the best accuracy.</p>
            ) : null}

            {fix && !locating ? (
              <>
                <div className="mt-3 rounded-xl border border-line bg-muted/60 p-3">
                  <p className="text-sm text-ink-secondary">
                    {addressLoading ? 'Finding address...' : address || 'Address unavailable'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href={mapsLink(fix.lat, fix.lng)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-brand-700"
                    >
                      <ExternalLink className="h-4 w-4" /> Open in Google Maps
                    </a>
                    <a
                      href={directionsLink(fix.lat, fix.lng)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-brand-700"
                    >
                      <Navigation className="h-4 w-4" /> Directions
                    </a>
                  </div>
                </div>
                {poor ? (
                  <label className="mt-3 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={forceSave} onChange={(e) => setForceSave(e.target.checked)} />
                    Save anyway
                  </label>
                ) : null}
                <input
                  className="mt-3 h-12 w-full rounded-xl border border-line px-3"
                  placeholder="Note (optional)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <button
                  type="button"
                  className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 text-lg font-semibold text-white disabled:opacity-50"
                  disabled={poor && !forceSave}
                  onClick={() => void savePin()}
                >
                  <MapPin className="h-5 w-5" /> Tag this house
                </button>
              </>
            ) : !fix && selectedTag ? (
              <div className="mt-3">
                <p className="text-sm text-ink-secondary">
                  Current pin · {selectedTag.accuracy_m != null ? `accuracy ±${Math.round(selectedTag.accuracy_m)} m` : 'manual pin'}
                </p>
                <div className="mt-3 rounded-xl border border-line bg-muted/60 p-3">
                  <p className="text-sm text-ink-secondary">{selectedTag.address?.trim() || 'Address unavailable'}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href={mapsLink(selectedTag.lat, selectedTag.lng)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-brand-700"
                    >
                      <ExternalLink className="h-4 w-4" /> Open in Google Maps
                    </a>
                    <a
                      href={directionsLink(selectedTag.lat, selectedTag.lng)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-brand-700"
                    >
                      <Navigation className="h-4 w-4" /> Directions
                    </a>
                  </div>
                </div>
                <p className="mt-3 text-sm text-ink-tertiary">Read GPS or tap the map to move it.</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
