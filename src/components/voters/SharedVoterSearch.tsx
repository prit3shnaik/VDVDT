import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Loader2 } from 'lucide-react'
import type { Voter } from '../../lib/types'
import {
  buildVoterLookupText,
  compactLookupValue,
  highlightMatch,
  initials,
  matchesLookupTokens,
  tokenizeLookup,
} from '../../lib/searchUtils'

export interface SharedVoterSearchProps {
  voters: Voter[]
  excludedIds: Set<string>
  selectedIds: Set<string>
  onSelectionChange: (ids: Set<string>) => void
  photoUrlByPath: Record<string, string>
  placeholder?: string
  maxDisplay?: number
  debounceMs?: number
}

export function SharedVoterSearch({
  voters,
  excludedIds,
  selectedIds,
  onSelectionChange,
  photoUrlByPath,
  placeholder = 'Search by name, EPIC, relative name, ward, part, section, house, contact...',
  maxDisplay = 60,
  debounceMs = 300,
}: SharedVoterSearchProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), debounceMs)
    return () => clearTimeout(timer)
  }, [query, debounceMs])

  const tokens = useMemo(() => tokenizeLookup(debouncedQuery), [debouncedQuery])

  const candidates = useMemo(() => {
    if (!tokens.length) return [] as Voter[]
    const compactSearch = tokens.join('')
    const firstToken = tokens[0] ?? ''

    return voters
      .filter((v) => {
        if (excludedIds.has(v.id)) return false
        return matchesLookupTokens(buildVoterLookupText(v), tokens)
      })
      .map((v) => {
        const epic = compactLookupValue(v.epic_no)
        const name = compactLookupValue(v.name)
        const aScore = epic === compactSearch || name === compactSearch
          ? 0
          : epic.startsWith(firstToken) || name.startsWith(firstToken)
            ? 1
            : 2
        return { voter: v, score: aScore }
      })
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score
        return a.voter.name.localeCompare(b.voter.name)
      })
      .slice(0, maxDisplay)
      .map((item) => item.voter)
  }, [voters, excludedIds, tokens, maxDisplay])

  const toggle = useCallback(
    (id: string) => {
      if (excludedIds.has(id)) return
      const next = new Set(selectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      onSelectionChange(next)
    },
    [selectedIds, excludedIds, onSelectionChange],
  )

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const showDropdown = isOpen && debouncedQuery.trim().length > 0

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
        <input
          ref={inputRef}
          className="h-11 w-full rounded-2xl border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            if (!isOpen) setIsOpen(true)
          }}
          onFocus={() => setIsOpen(true)}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setDebouncedQuery('')
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-tertiary hover:bg-muted hover:text-ink-secondary"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="absolute z-20 mt-2 w-full rounded-2xl border border-line bg-white max-h-96 overflow-y-auto">
          {debouncedQuery !== query ? (
            <div className="flex items-center justify-center px-4 py-10">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-ink-tertiary" />
              <span className="text-sm text-ink-tertiary">Searching...</span>
            </div>
          ) : candidates.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-ink-tertiary">
              {debouncedQuery
                ? 'No voters match your search.'
                : 'Start typing to search voters.'}
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {candidates.map((v) => {
                const selected = selectedIds.has(v.id)
                const alreadyAdded = excludedIds.has(v.id)
                const photo = v.photo_url ? photoUrlByPath[v.photo_url] : undefined

                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => toggle(v.id)}
                      disabled={alreadyAdded}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${
                        selected ? 'bg-brand-50/60' : ''
                      }`}
                    >
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-white shadow-sm">
                        {photo ? (
                          <img src={photo} alt={v.name} className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-[10px] font-semibold text-brand-700">
                            {initials(v.name)}
                          </span>
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <p className="truncate text-sm font-semibold text-ink">
                            {highlightMatch(v.name, tokens)}
                          </p>
                          {alreadyAdded && (
                            <span className="flex-shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              Already Added
                            </span>
                          )}
                          {selected && !alreadyAdded && (
                            <span className="flex-shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                              Selected
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-secondary">
                          <span>
                            EPIC{' '}
                            <span className="font-medium text-ink">
                              {highlightMatch(v.epic_no, tokens)}
                            </span>
                          </span>
                          {v.relative_name && (
                            <span className="truncate max-w-[140px]">
                              {v.relative_relation ? `${v.relative_relation}. ` : ''}
                              <span className="font-medium text-ink">
                                {highlightMatch(v.relative_name, tokens)}
                              </span>
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-tertiary">
                          {v.house_no && (
                            <span>
                              H.No <span className="font-medium text-ink-secondary">{highlightMatch(v.house_no, tokens)}</span>
                            </span>
                          )}
                          {v.ward_no != null && (
                            <span>
                              Ward <span className="font-medium text-ink-secondary">{v.ward_no}</span>
                            </span>
                          )}
                          {v.part_no != null && (
                            <span>
                              Part <span className="font-medium text-ink-secondary">{v.part_no}</span>
                            </span>
                          )}
                          {v.section != null && (
                            <span>
                              Sec <span className="font-medium text-ink-secondary">{v.section}</span>
                            </span>
                          )}
                          {v.age != null && (
                            <span>
                              Age <span className="font-medium text-ink-secondary">{v.age}</span>
                            </span>
                          )}
                          {v.gender && (
                            <span className="font-medium text-ink-secondary">{v.gender}</span>
                          )}
                          {v.contact_no_1 && (
                            <span>
                              <span className="font-medium text-ink-secondary">{highlightMatch(v.contact_no_1, tokens)}</span>
                            </span>
                          )}
                          {v.family_label && (
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">
                              {highlightMatch(v.family_label, tokens)}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
