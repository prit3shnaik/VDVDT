import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import { CalendarClock, MessageSquare, Phone } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { VoterDetailDrawer } from '../../components/voters/VoterDetailDrawer'
import { FilterChip } from '../../components/ui/FilterChip'
import { Button } from '../../components/ui/Button'
import type { Voter } from '../../lib/types'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { buildWardScope, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters, writeCachedVoters } from '../../lib/voterCache'
import { withNormalizedVoterCategories } from '../../lib/voterCategory'

const BIRTHDAYS_CACHE_KEY = 'vote:birthdays:voters-cache'

dayjs.extend(customParseFormat)

function parseDob(value: string) {
  const parsed = dayjs(value, ['YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY'], true)
  if (parsed.isValid()) {
    return parsed
  }

  const fallback = dayjs(value)
  return fallback.isValid() ? fallback : null
}

function daysUntil(dob: string) {
  const parsedDob = parseDob(dob)
  if (!parsedDob) {
    return Number.POSITIVE_INFINITY
  }

  const now = dayjs().startOf('day')
  const birthdayThisYear = parsedDob.year(now.year()).startOf('day')
  const next = birthdayThisYear.isBefore(now, 'day') ? birthdayThisYear.add(1, 'year') : birthdayThisYear
  return next.diff(now, 'day')
}

function formatDob(dob: string | null) {
  if (!dob) {
    return '-'
  }

  const parsedDob = parseDob(dob)
  return parsedDob ? parsedDob.format('DD-MM-YYYY') : dob
}

export function BirthdaysPage() {
  const [rows, setRows] = useState<Voter[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVoter, setSelectedVoter] = useState<Voter | null>(null)
  const [photoUrlByPath, setPhotoUrlByPath] = useState<Record<string, string>>({})
  const [range, setRange] = useState<7 | 30>(30)
  const { profile } = useAuth()
  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)

  const load = useCallback(async () => {
    const cachedRows = withNormalizedVoterCategories(readCachedVoters(BIRTHDAYS_CACHE_KEY, wardScope, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
    setLoading(!cachedRows.length)
    if (cachedRows.length) {
      setRows(cachedRows)
    }

    const allowedWards = profile?.allowed_wards ?? []
    const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

    let request = supabase.from('voters').select('*').not('date_of_birth', 'is', null)
    if (hasWardRestriction) {
      request = request.in('ward_no', allowedWards)
    }

    const { data, error } = await request
    if (error) {
      setLoading(false)
      return
    }

    const nextRows = withNormalizedVoterCategories((data as Voter[] | null) ?? [])
    setRows(nextRows)
    writeCachedVoters(BIRTHDAYS_CACHE_KEY, wardScope, nextRows)
    setLoading(false)
  }, [profile?.allowed_wards, profile?.role, wardScope])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const photoPaths = Array.from(new Set(rows.map((voter) => voter.photo_url).filter(Boolean))) as string[]
    const missingPaths = photoPaths.filter((path) => !photoUrlByPath[path])
    if (!missingPaths.length) {
      return
    }

    supabase.storage
      .from('voter-photos')
      .createSignedUrls(missingPaths, 60 * 60)
      .then(({ data, error }) => {
        if (error || !data) {
          return
        }

        const next: Record<string, string> = {}
        for (let index = 0; index < missingPaths.length; index += 1) {
          const path = missingPaths[index]
          const signed = data[index]?.signedUrl
          if (signed) {
            next[path] = signed
          }
        }

        if (Object.keys(next).length) {
          setPhotoUrlByPath((current) => ({ ...current, ...next }))
        }
      })
  }, [photoUrlByPath, rows])

  const upcoming = useMemo(
    () =>
      rows
        .filter((row) => row.date_of_birth)
        .map((row) => ({ row, countdown: daysUntil(row.date_of_birth as string) }))
        .filter((entry) => Number.isFinite(entry.countdown))
        .sort((a, b) => a.countdown - b.countdown)
        .slice(0, 40),
    [rows],
  )

  const visible = useMemo(
    () => upcoming.filter((entry) => entry.countdown <= range),
    [upcoming, range],
  )

  return (
    <div>
      <PageHeader
        title="Birthdays"
        description={`${visible.length} upcoming in the next ${range} days. Call, WhatsApp, or SMS from the list.`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip active={range === 7} onClick={() => setRange(7)}>7 days</FilterChip>
        <FilterChip active={range === 30} onClick={() => setRange(30)}>30 days</FilterChip>
      </div>

      <section className="rounded-xl border border-line bg-white p-4">
        {loading ? <p className="px-1 pb-3 text-sm text-ink-secondary">Loading birthdays...</p> : null}
        {visible.length === 0 && !loading ? (
          <p className="px-1 py-8 text-center text-sm text-ink-tertiary">No birthdays in the next {range} days.</p>
        ) : null}
        <ul className="divide-y divide-line">
          {visible.map(({ row, countdown }) => (
            <li
              key={row.id}
              className="flex cursor-pointer flex-wrap items-center justify-between gap-3 py-3 hover:bg-muted"
              onClick={() => setSelectedVoter(row)}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-line bg-white">
                  {row.photo_url && photoUrlByPath[row.photo_url] ? (
                    <img src={photoUrlByPath[row.photo_url]} alt={row.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xs font-semibold text-brand-700">
                      {row.name
                        .split(' ')
                        .map((part) => part.charAt(0))
                        .slice(0, 2)
                        .join('')
                        .toUpperCase()}
                    </span>
                  )}
                </div>
                <div>
                <p className="font-medium text-ink">{row.name}</p>
                <p className="text-sm text-ink-secondary">DOB {formatDob(row.date_of_birth)}</p>
                <p className="text-xs text-ink-tertiary">
                  EPIC {row.epic_no} · Part {row.part_no ?? '-'} · Section {row.section ?? '-'} · House {row.house_no ?? '-'}
                </p>
                {countdown === 0 ? (
                  <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-[var(--success-border)] bg-[var(--success-fill)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--success)]">
                    <CalendarClock className="h-3.5 w-3.5" />
                    Today
                  </p>
                ) : (
                  <p className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-ink-tertiary">
                    <CalendarClock className="h-3.5 w-3.5" />
                    In {countdown} days
                  </p>
                )}
                </div>
              </div>
              <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                <Button variant="icon" aria-label="Call" disabled={!row.contact_no_1} onClick={() => { if (row.contact_no_1) window.location.href = `tel:${row.contact_no_1}` }}>
                  <Phone className="h-4 w-4" />
                </Button>
                <Button variant="icon" aria-label="WhatsApp" disabled={!row.contact_no_1} onClick={() => { if (row.contact_no_1) window.open(`https://wa.me/91${row.contact_no_1}`, '_blank', 'noopener,noreferrer') }}>
                  <MessageSquare className="h-4 w-4" />
                </Button>
                <Button variant="icon" aria-label="SMS" disabled={!row.contact_no_1} onClick={() => { if (row.contact_no_1) window.location.href = `sms:${row.contact_no_1}` }}>
                  SMS
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <VoterDetailDrawer
        voter={selectedVoter}
        onClose={() => setSelectedVoter(null)}
        onSaved={async () => {
          await load()
          if (selectedVoter?.id) {
            const { data } = await supabase.from('voters').select('*').eq('id', selectedVoter.id).maybeSingle()
            setSelectedVoter((data as Voter | null) ?? null)
          }
        }}
      />
    </div>
  )
}
