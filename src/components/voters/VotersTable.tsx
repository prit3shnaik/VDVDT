import { useEffect, useMemo, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type PaginationState,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDownUp, ChevronLeft, ChevronRight, Columns3 } from 'lucide-react'
import type { CustomField, Voter } from '../../lib/types'
import { voterCategoryLabel } from '../../lib/voterCategory'
import { formatDate } from '../../lib/utils'

function sanitizePhoneNumber(value: string | null | undefined): string {
  return (value ?? '').replace(/[^\d+]/g, '')
}

interface CustomFieldStoredValue {
  value: unknown
  note?: unknown
}

const isStoredCustomValue = (value: unknown): value is CustomFieldStoredValue => {
  return Boolean(value) && typeof value === 'object' && 'value' in (value as Record<string, unknown>)
}

const getStoredFieldValue = (value: unknown) => {
  if (isStoredCustomValue(value)) {
    return value.value
  }

  return value
}

const getStoredFieldNote = (value: unknown) => {
  if (!isStoredCustomValue(value)) {
    return ''
  }

  const note = value.note
  if (note === null || note === undefined) {
    return ''
  }

  return String(note)
}

const formatCustomValue = (field: CustomField, value: unknown): string => {
  const resolvedValue = getStoredFieldValue(value)
  const note = getStoredFieldNote(value).trim()

  let valueText = '-'
  if (Array.isArray(resolvedValue)) {
    valueText = resolvedValue.map((item) => String(item).trim()).filter(Boolean).join(', ') || '-'
  } else if (resolvedValue === true) {
    valueText = 'Yes'
  } else if (resolvedValue === false) {
    valueText = 'No'
  } else if (resolvedValue !== null && resolvedValue !== undefined && String(resolvedValue).trim()) {
    valueText = String(resolvedValue)
  }

  if (field.allow_custom_note && note) {
    return valueText === '-' ? note : `${valueText} (${note})`
  }

  return valueText
}

interface VotersTableProps {
  voters: Voter[]
  photoUrls: Record<string, string>
  onSelectVoter: (voter: Voter) => void
  customFields?: CustomField[]
  customFieldValuesByVoterId?: Record<string, Record<string, unknown>>
  rowClassByVoterId?: Record<string, string>
  pageSize?: number
  onPageSizeChange?: (pageSize: number) => void
  density?: 'compact' | 'comfortable'
}

export function VotersTable({
  voters,
  photoUrls,
  onSelectVoter,
  customFields = [],
  customFieldValuesByVoterId = {},
  rowClassByVoterId,
  pageSize = 20,
  onPageSizeChange,
  density = 'comfortable',
}: VotersTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({})
  const [showColumnMenu, setShowColumnMenu] = useState(false)
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: Math.max(pageSize, 1) })
  const [goToPageInput, setGoToPageInput] = useState('1')

  useEffect(() => {
    setPagination((current) => ({ ...current, pageIndex: 0 }))
  }, [voters.length])

  useEffect(() => {
    setPagination((current) => ({ ...current, pageIndex: 0, pageSize: Math.max(pageSize, 1) }))
  }, [pageSize])

  useEffect(() => {
    setGoToPageInput(String(pagination.pageIndex + 1))
  }, [pagination.pageIndex])

  const columns = useMemo<ColumnDef<Voter>[]>(
    () => [
      {
        id: 'photo',
        header: 'Photo',
        cell: ({ row }) => {
          const photo = photoUrls[row.original.id]
          if (photo) {
            return (
              <img
                src={photo}
                alt={row.original.name}
                loading="lazy"
                decoding="async"
                className="h-7 w-7 rounded-lg border border-line object-cover sm:h-9 sm:w-9"
              />
            )
          }

          return (
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700 sm:h-9 sm:w-9 sm:text-xs">
              {row.original.name
                .split(' ')
                .map((part) => part.charAt(0))
                .slice(0, 2)
                .join('')
                .toUpperCase()}
            </span>
          )
        },
      },
      { accessorKey: 'sr_no_roll', header: 'Sr No' },
      { accessorKey: 'ward_no', header: 'Ward' },
      { accessorKey: 'part_no', header: 'Part No' },
      { accessorKey: 'section', header: 'Section' },
      { accessorKey: 'section_name', header: 'Section Name' },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <span>{row.original.name}</span>
          </span>
        ),
      },
      { accessorKey: 'relative_name', header: 'Relative Name' },
      { accessorKey: 'relative_relation', header: 'Relative Relation' },
      { accessorKey: 'epic_no', header: 'EPIC No' },
      { accessorKey: 'house_no', header: 'House No' },
      { accessorKey: 'age', header: 'Age' },
      {
        accessorKey: 'date_of_birth',
        header: 'DOB',
        cell: ({ row }) => formatDate(row.original.date_of_birth),
      },
      {
        accessorKey: 'contact_no_1',
        header: 'Contact No 1',
        cell: ({ row }) => {
          const phone = sanitizePhoneNumber(row.original.contact_no_1)
          if (!phone) {
            return '-'
          }

          return (
            <a
              href={`tel:${phone}`}
              className="text-brand-700 underline-offset-2 hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {row.original.contact_no_1}
            </a>
          )
        },
      },
      {
        accessorKey: 'contact_no_2',
        header: 'Contact No 2',
        cell: ({ row }) => {
          const phone = sanitizePhoneNumber(row.original.contact_no_2)
          if (!phone) {
            return '-'
          }

          return (
            <a
              href={`tel:${phone}`}
              className="text-brand-700 underline-offset-2 hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {row.original.contact_no_2}
            </a>
          )
        },
      },
      { accessorKey: 'gender', header: 'Gender' },
      { accessorKey: 'religion', header: 'Religion' },
      { accessorKey: 'state', header: 'State' },
      {
        id: 'voter_category',
        accessorKey: 'voter_category',
        header: 'Category',
        cell: ({ row }) => voterCategoryLabel(row.original.voter_category) ?? '-',
      },
      { accessorKey: 'family_head_epic', header: 'Family Status' },
      ...customFields.map<ColumnDef<Voter>>((field) => ({
        id: `custom:${field.id}`,
        header: field.label,
        cell: ({ row }) => {
          const value = customFieldValuesByVoterId[row.original.id]?.[field.id]
          return formatCustomValue(field, value)
        },
      })),
    ],
    [customFieldValuesByVoterId, customFields, photoUrls],
  )

  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([
    'sr_no_roll',
    'photo',
    'ward_no',
    'part_no',
    'section',
    'section_name',
    'name',
    'relative_name',
    'relative_relation',
    'epic_no',
    'house_no',
    'age',
    'date_of_birth',
    'contact_no_1',
    'contact_no_2',
    'gender',
    'religion',
    'state',
    'voter_category',
    'family_head_epic',
  ])

  useEffect(() => {
    const customColumnIds = customFields.map((field) => `custom:${field.id}`)
    setColumnOrder((current) => {
      const withoutRemoved = current.filter((columnId) => !columnId.startsWith('custom:') || customColumnIds.includes(columnId))
      const missing = customColumnIds.filter((columnId) => !withoutRemoved.includes(columnId))
      return [...withoutRemoved, ...missing]
    })
  }, [customFields])

  const table = useReactTable({
    data: voters,
    columns,
    state: {
      sorting,
      globalFilter,
      columnVisibility,
      columnOrder,
      pagination,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onPaginationChange: setPagination,
    autoResetPageIndex: true,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: (row, _columnId, value) => {
      const text = String(value).toLowerCase().trim()
      if (!text) {
        return true
      }

      const customSearch = customFields
        .map((field) => formatCustomValue(field, customFieldValuesByVoterId[row.original.id]?.[field.id]))
        .join(' ')

      return [row.original.name, row.original.epic_no, row.original.contact_no_1, customSearch]
        .join(' ')
        .toLowerCase()
        .includes(text)
    },
  })

  const moveColumn = (id: string, direction: 'left' | 'right') => {
    const order = [...columnOrder]
    const currentIndex = order.findIndex((key) => key === id)
    if (currentIndex < 0) {
      return
    }

    const targetIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1
    if (targetIndex < 0 || targetIndex >= order.length) {
      return
    }

    ;[order[currentIndex], order[targetIndex]] = [order[targetIndex], order[currentIndex]]
    setColumnOrder(order)
  }

  const maxPage = Math.max(table.getPageCount(), 1)

  const jumpToPage = () => {
    const parsed = Number(goToPageInput)
    if (!Number.isFinite(parsed)) {
      setGoToPageInput(String(table.getState().pagination.pageIndex + 1))
      return
    }

    const nextPage = Math.min(Math.max(Math.trunc(parsed), 1), maxPage)
    table.setPageIndex(nextPage - 1)
    setGoToPageInput(String(nextPage))
  }

  return (
    <section className="rounded-xl border border-line bg-white p-1.5 shadow-soft sm:p-2.5 lg:p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={globalFilter}
          onChange={(event) => setGlobalFilter(event.target.value)}
          placeholder="Search name, EPIC, mobile"
          className="h-10 min-w-[220px] rounded-lg border border-line bg-muted/40 px-2.5 text-sm outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-200"
        />

        <div className="relative ml-auto">
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-2.5 text-sm font-medium text-ink-secondary shadow-sm transition hover:bg-muted"
            onClick={() => setShowColumnMenu((open) => !open)}
          >
            <Columns3 className="h-4 w-4" />
            Columns
          </button>

          {showColumnMenu ? (
            <div className="absolute right-0 z-10 mt-2 w-72 rounded-xl border border-line bg-white p-2 shadow-popover">
              {table.getAllLeafColumns().map((column) => (
                <div className="flex items-center justify-between gap-2 px-2 py-1" key={column.id}>
                  <label className="flex items-center gap-2 text-xs text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={column.getIsVisible()}
                      onChange={column.getToggleVisibilityHandler()}
                    />
                    {column.columnDef.header as string}
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded-md border border-line px-2 text-xs"
                      onClick={() => moveColumn(column.id, 'left')}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-line px-2 text-xs"
                      onClick={() => moveColumn(column.id, 'right')}
                    >
                      →
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className={`min-w-full border-separate border-spacing-0 ${density === 'compact' ? 'text-[11px] sm:text-xs' : 'text-xs sm:text-[13px]'}`}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header, headerIndex) => (
                  <th
                    key={header.id}
                    className={`sticky top-0 z-[1] border-b border-line bg-[#f7f9fd] text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary ${
                      density === 'compact' ? 'px-2 py-1.5 sm:px-2.5 sm:py-2' : 'px-2.5 py-2.5 sm:px-3 sm:py-2.5'
                    } ${headerIndex === 0 || header.column.id === 'name' || header.column.id === 'photo' ? 'sticky left-0 z-[2] bg-[#f7f9fd]' : ''}`}
                  >
                    {header.isPlaceholder ? null : (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <ArrowDownUp className="h-3.5 w-3.5 text-ink-tertiary" />
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={`group cursor-pointer transition-colors hover:bg-[#f5f7fd] ${rowClassByVoterId?.[row.original.id] ?? ''}`}
                onClick={() => onSelectVoter(row.original)}
              >
                {row.getVisibleCells().map((cell, cellIndex) => (
                  <td
                    key={cell.id}
                    className={`border-b border-line text-ink ${
                      density === 'compact' ? 'px-2 py-1.5 sm:px-2.5 sm:py-2' : 'px-2.5 py-2.5 sm:px-3 sm:py-2.5'
                    } ${cell.column.id === 'name' ? 'font-medium' : ''} ${cellIndex === 0 || cell.column.id === 'name' || cell.column.id === 'photo' ? 'sticky left-0 z-[1] bg-white group-hover:bg-[#f5f7fd]' : ''}`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-xs text-ink-secondary">
          Showing {table.getRowModel().rows.length} rows ({table.getFilteredRowModel().rows.length} after filter)
        </p>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-ink-secondary" htmlFor="voters-table-page-size">
            Rows
          </label>
          <select
            id="voters-table-page-size"
            className="h-8 rounded-lg border border-line bg-white px-2 text-xs outline-none focus:border-brand-500"
            value={String(table.getState().pagination.pageSize)}
            onChange={(event) => {
              const nextSize = Number(event.target.value)
              onPageSizeChange?.(nextSize)
              table.setPageSize(nextSize)
            }}
            aria-label="Rows per page"
            title="Rows per page"
          >
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>

          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-secondary transition hover:bg-muted disabled:opacity-40"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-ink-secondary">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount() || 1}
          </span>

          <input
            value={goToPageInput}
            onChange={(event) => setGoToPageInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                jumpToPage()
              }
            }}
            onBlur={jumpToPage}
            inputMode="numeric"
            pattern="[0-9]*"
            className="h-8 w-16 rounded-lg border border-line bg-white px-2 text-xs outline-none focus:border-brand-500"
            aria-label="Go to page"
            title="Go to page"
          />

          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink-secondary transition hover:bg-muted disabled:opacity-40"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  )
}
