import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid } from 'recharts'
import {
  CalendarClock,
  CalendarDays,
  FolderOpen,
  Search,
  UserPlus,
  Users,
  UsersRound,
} from 'lucide-react'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../../components/common/PageHeader'
import { StatCard } from '../../components/common/StatCard'
import { Button } from '../../components/ui/Button'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { usePersistentState } from '../../hooks/usePersistentState'
import { formatNumber } from '../../lib/utils'
import type { Voter } from '../../lib/types'
import { buildWardScope, FAST_NAV_CACHE_MAX_AGE_MS, readCachedVoters, writeCachedVoters, clearCachedCollection } from '../../lib/voterCache'
import { withNormalizedVoterCategories } from '../../lib/voterCategory'
import { fetchApiJson } from '../../lib/d1Query'
import { invalidateVoterCache } from '../../lib/voterDataset'
import { clearTeamLeaderDetailCache, clearTeamLeadersListCache, clearUnassignedDataCache } from '../../lib/teamLeaderCache'

type ReportType = 'religion' | 'gender' | 'state' | 'part' | 'ward' | 'age_band'

const DASHBOARD_CACHE_KEY = 'vote:dashboard:voters-cache'

interface DistributionRow {
  key: string
  label: string
  count: number
}

const CHART_SERIES = ['#4F46E5', '#2563EB', '#0EA5E9', '#0F766E', '#D97706', '#BE123C', '#64748B']

function colorForLabel(label: string) {
  let hash = 0
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) >>> 0
  }
  return CHART_SERIES[hash % CHART_SERIES.length]
}

function genderColor(label: string) {
  const key = label.toUpperCase()
  if (key === 'MALE') return '#4F46E5'
  if (key === 'FEMALE') return '#0EA5E9'
  return '#64748B'
}

function percentOf(count: number, total: number) {
  if (!total) return '0% of roll'
  return `${Math.round((count / total) * 100)}% of roll`
}

function toWorkbookSheet(data: unknown[]) {
  if (!data.length) {
    return XLSX.utils.json_to_sheet([{ message: 'No rows' }])
  }
  return XLSX.utils.json_to_sheet(data)
}

function normalizeLabel(value: string | null | undefined, fallback = 'Unknown'): string {
  const text = (value ?? '').trim()
  return text || fallback
}

function getAgeBand(age: number | null): string {
  if (age === null || age < 18) {
    return 'Unknown/Under 18'
  }
  if (age <= 25) {
    return '18-25'
  }
  if (age <= 35) {
    return '26-35'
  }
  if (age <= 45) {
    return '36-45'
  }
  if (age <= 60) {
    return '46-60'
  }
  return '60+'
}

function exportWorkbook(sheets: Array<{ name: string; rows: unknown[] }>, fileName: string) {
  const workbook = XLSX.utils.book_new()
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, toWorkbookSheet(sheet.rows), sheet.name)
  }
  XLSX.writeFile(workbook, fileName)
}

interface BulkDeletePreview {
  requested: number
  found: number
  notFound: string[]
  deleteCount: number
  wholeFamilies: number
  memberOnly: number
  headRewrites: Array<{ fromEpic: string; fromName: string; toEpic: string; toName: string; remainingCount: number }>
  voters: Array<{ id: string; epic_no: string; name: string; part_no: number | null; ward_no: number | null; family_head_epic: string | null }>
}

interface BulkDisablePreview {
  requested: number
  found: number
  notFound: string[]
  alreadyDisabled?: number
  alreadyActive?: number
  changeCount: number
  disableCount?: number
  enableCount?: number
  voters: Array<{ id: string; epic_no: string; name: string; part_no: number | null; section: number | null; ward_no: number | null }>
}

function parseEpicTokens(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of text.split(/[\s,;]+/)) {
    const epic = token.trim().toUpperCase()
    if (epic.length < 3 || seen.has(epic)) continue
    seen.add(epic)
    out.push(epic)
  }
  return out
}

export function DashboardPage() {
  const { isAdminAreaAllowed, profile, loading: authLoading } = useAuth()
  const [voters, setVoters] = useState<Voter[]>([])
  const [loading, setLoading] = useState(true)
  const [genderTotals, setGenderTotals] = useState<{ total: number; male: number; female: number; other: number } | null>(null)
  const [partToDelete, setPartToDelete] = useState('')
  const [epicListText, setEpicListText] = useState('')
  const [epicPreview, setEpicPreview] = useState<BulkDeletePreview | null>(null)
  const [disableEpicText, setDisableEpicText] = useState('')
  const [disablePreview, setDisablePreview] = useState<BulkDisablePreview | null>(null)
  const [runningAction, setRunningAction] = useState<string | null>(null)
  const [mobileSearch, setMobileSearch] = useState('')
  const [rollMaintenanceOpen, setRollMaintenanceOpen] = useState(false)
  const [reportType, setReportType] = usePersistentState<ReportType>('vote:dashboard:reportType', 'religion')
  const [selectedReportKey, setSelectedReportKey] = usePersistentState<string | null>('vote:dashboard:selectedReportKey', null)
  const navigate = useNavigate()
  const wardScope = buildWardScope(profile?.role, profile?.allowed_wards)

  const load = useCallback(async () => {
    const cachedRows = withNormalizedVoterCategories(readCachedVoters(DASHBOARD_CACHE_KEY, wardScope, FAST_NAV_CACHE_MAX_AGE_MS) ?? [])
    setLoading(!cachedRows.length)
    if (cachedRows.length) {
      setVoters(cachedRows)
    }

    const allowedWards = profile?.allowed_wards ?? []
    const hasWardRestriction = (profile?.role ?? 'user') !== 'admin' && allowedWards.length > 0

    if (!hasWardRestriction) {
      try {
        const data = await fetchApiJson<{ stats: { total_voters?: number; male_count?: number; female_count?: number; other_count?: number } | null }>('/api/dashboard-stats')
        const total = Number(data.stats?.total_voters ?? 0)
        const male = Number(data.stats?.male_count ?? 0)
        const female = Number(data.stats?.female_count ?? 0)
        const other = Number(data.stats?.other_count ?? 0)
        if (data.stats && (total > 0 || male > 0 || female > 0 || other > 0)) {
          setGenderTotals({ total, male, female, other })
        } else {
          setGenderTotals(null)
        }
      } catch {
        setGenderTotals(null)
      }
    } else {
      setGenderTotals(null)
    }

    const batchSize = 400
    let offset = 0
    const allRows: Voter[] = []
    let firstChunkRendered = Boolean(cachedRows.length)

    for (;;) {
      let request = supabase
        .from('voters')
        .select('*')
        .order('updated_at', { ascending: false })
        .range(offset, offset + batchSize - 1)

      if (hasWardRestriction) {
        request = request.in('ward_no', allowedWards)
      }

      const { data, error } = await request
      if (error) {
        toast.error(error.message)
        setLoading(false)
        return
      }

      const chunk = withNormalizedVoterCategories((data as Voter[] | null) ?? [])
      allRows.push(...chunk)

      if (!firstChunkRendered && chunk.length) {
        setVoters([...allRows])
        setLoading(false)
        firstChunkRendered = true
      }

      if (chunk.length < batchSize) {
        break
      }

      offset += batchSize
    }

    if (!firstChunkRendered) {
      setLoading(false)
    }

    setVoters(allRows)
    writeCachedVoters(DASHBOARD_CACHE_KEY, wardScope, allRows)
    setLoading(false)
  }, [profile?.allowed_wards, profile?.role, wardScope])

  useEffect(() => {
    if (authLoading) return
    void load()
  }, [load, authLoading])

  const maleCount = useMemo(
    () => genderTotals?.male ?? voters.filter((voter) => voter.gender === 'MALE').length,
    [genderTotals, voters],
  )
  const femaleCount = useMemo(
    () => genderTotals?.female ?? voters.filter((voter) => voter.gender === 'FEMALE').length,
    [genderTotals, voters],
  )
  const otherCount = useMemo(
    () => genderTotals?.other ?? voters.filter((voter) => voter.gender === 'OTHER').length,
    [genderTotals, voters],
  )
  const totalVoters = genderTotals?.total ?? voters.length

  const compactStats = [
    { label: 'Total', value: formatNumber(totalVoters) },
    { label: 'Male', value: formatNumber(maleCount) },
    { label: 'Female', value: formatNumber(femaleCount) },
    { label: 'Other', value: formatNumber(otherCount) },
  ]

  const religionRows = useMemo<DistributionRow[]>(() => {
    const map = new Map<string, number>()
    for (const voter of voters) {
      const key = normalizeLabel(voter.religion)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([label, count]) => ({ key: label, label, count }))
      .sort((a, b) => b.count - a.count)
  }, [voters])

  const genderRows = useMemo<DistributionRow[]>(() => {
    const map = new Map<string, number>()
    for (const voter of voters) {
      const key = normalizeLabel(voter.gender)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([label, count]) => ({ key: label, label, count }))
      .sort((a, b) => b.count - a.count)
  }, [voters])

  const ageBandRows = useMemo<DistributionRow[]>(() => {
    const map = new Map<string, number>()
    for (const voter of voters) {
      const key = getAgeBand(voter.age)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([label, count]) => ({ key: label, label, count }))
      .sort((a, b) => b.count - a.count)
  }, [voters])

  const reportRows = useMemo<DistributionRow[]>(() => {
    const map = new Map<string, number>()
    for (const voter of voters) {
      let key: string
      if (reportType === 'religion') {
        key = normalizeLabel(voter.religion)
      } else if (reportType === 'gender') {
        key = normalizeLabel(voter.gender)
      } else if (reportType === 'state') {
        key = normalizeLabel(voter.state)
      } else if (reportType === 'part') {
        key = voter.part_no === null ? 'Unknown' : String(voter.part_no)
      } else if (reportType === 'ward') {
        key = voter.ward_no === null ? 'Unassigned' : String(voter.ward_no)
      } else {
        key = getAgeBand(voter.age)
      }
      map.set(key, (map.get(key) ?? 0) + 1)
    }

    return Array.from(map.entries())
      .map(([label, count]) => ({ key: label, label, count }))
      .sort((a, b) => b.count - a.count)
  }, [reportType, voters])

  const detailRows = useMemo(() => {
    if (!selectedReportKey) {
      return []
    }
    return voters
      .filter((voter) => {
        if (reportType === 'religion') {
          return normalizeLabel(voter.religion) === selectedReportKey
        }
        if (reportType === 'gender') {
          return normalizeLabel(voter.gender) === selectedReportKey
        }
        if (reportType === 'state') {
          return normalizeLabel(voter.state) === selectedReportKey
        }
        if (reportType === 'part') {
          return (voter.part_no === null ? 'Unknown' : String(voter.part_no)) === selectedReportKey
        }
        if (reportType === 'ward') {
          return (voter.ward_no === null ? 'Unassigned' : String(voter.ward_no)) === selectedReportKey
        }
        return getAgeBand(voter.age) === selectedReportKey
      })
      .sort((a, b) => {
        if ((a.part_no ?? 0) !== (b.part_no ?? 0)) {
          return (a.part_no ?? 0) - (b.part_no ?? 0)
        }
        if ((a.section ?? 0) !== (b.section ?? 0)) {
          return (a.section ?? 0) - (b.section ?? 0)
        }
        return (a.sr_no_roll ?? 0) - (b.sr_no_roll ?? 0)
      })
  }, [reportType, selectedReportKey, voters])

  const runWithGuard = async (name: string, handler: () => Promise<void>) => {
    try {
      setRunningAction(name)
      await handler()
    } finally {
      setRunningAction(null)
    }
  }

  const handleMobileSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const term = mobileSearch.trim()
    navigate(term ? `/voters?q=${encodeURIComponent(term)}` : '/voters')
  }

  const mobileQuickActions = [
    { label: 'Voters', path: '/voters', icon: Users },
    { label: 'Families', path: '/families', icon: UsersRound },
    { label: 'Groups', path: '/groups', icon: FolderOpen },
    { label: 'Birthdays', path: '/birthdays', icon: CalendarClock },
    { label: 'Meetings', path: '/meetings', icon: CalendarDays },
  ]

  const handleExportAll = async () => {
    await runWithGuard('export_all', async () => {
      const { data, error } = await supabase.from('voters').select('*').order('part_no').order('section').order('sr_no_roll')
      if (error) {
        toast.error(error.message)
        return
      }

      exportWorkbook(
        [
          {
            name: 'Voters',
            rows: (data as Record<string, unknown>[] | null) ?? [],
          },
        ],
        `voters-all-${new Date().toISOString().slice(0, 10)}.xlsx`,
      )
      toast.success('All voter data exported.')
    })
  }

  const handleExportReports = () => {
    exportWorkbook(
      [
        { name: 'Religion Distribution', rows: religionRows },
        { name: 'Gender Distribution', rows: genderRows },
        { name: 'Age Band Distribution', rows: ageBandRows },
        { name: 'Current Report Summary', rows: reportRows },
        {
          name: 'Current Report Details',
          rows: detailRows.map((row) => ({
            epic_no: row.epic_no,
            name: row.name,
            part_no: row.part_no,
            section: row.section,
            sr_no_roll: row.sr_no_roll,
            religion: row.religion,
            gender: row.gender,
            state: row.state,
            ward_no: row.ward_no,
          })),
        },
      ],
      `dashboard-reports-${new Date().toISOString().slice(0, 10)}.xlsx`,
    )
    toast.success('Reports exported successfully.')
  }

  const handlePartwiseReport = async () => {
    await runWithGuard('part_report', async () => {
      const rows = reportRows
        .filter((row) => row.label !== 'Unknown')
        .map((row) => ({ part_no: row.label, voter_count: row.count }))
      exportWorkbook([{ name: 'Part-wise Report', rows }], `part-wise-report-${new Date().toISOString().slice(0, 10)}.xlsx`)
      toast.success('Part-wise report generated.')
    })
  }

  const handleBackupAllApplicationData = async () => {
    await runWithGuard('backup_all', async () => {
      const [votersRes, usersRes, activityRes, importRes, customFieldRes, customValuesRes, presetsRes] = await Promise.all([
        supabase.from('voters').select('*').limit(20000),
        supabase.from('users').select('*').limit(5000),
        supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(20000),
        supabase.from('import_batches').select('*').order('created_at', { ascending: false }).limit(10000),
        supabase.from('custom_fields').select('*').limit(5000),
        supabase.from('custom_field_values').select('*').limit(20000),
        supabase.from('saved_filter_presets').select('*').limit(5000),
      ])

      const firstError = [
        votersRes.error,
        usersRes.error,
        activityRes.error,
        importRes.error,
        customFieldRes.error,
        customValuesRes.error,
        presetsRes.error,
      ].find(Boolean)

      if (firstError) {
        toast.error(firstError.message)
        return
      }

      exportWorkbook(
        [
          { name: 'Voters', rows: (votersRes.data as Record<string, unknown>[] | null) ?? [] },
          { name: 'Users', rows: (usersRes.data as Record<string, unknown>[] | null) ?? [] },
          { name: 'Activity Logs', rows: (activityRes.data as Record<string, unknown>[] | null) ?? [] },
          { name: 'Import Batches', rows: (importRes.data as Record<string, unknown>[] | null) ?? [] },
          { name: 'Custom Fields', rows: (customFieldRes.data as Record<string, unknown>[] | null) ?? [] },
          { name: 'Custom Values', rows: (customValuesRes.data as Record<string, unknown>[] | null) ?? [] },
          { name: 'Saved Presets', rows: (presetsRes.data as Record<string, unknown>[] | null) ?? [] },
        ],
        `voterdata-full-backup-${new Date().toISOString().slice(0, 10)}.xlsx`,
      )
      toast.success('Full application backup exported.')
    })
  }

  const handleDeleteAll = async () => {
    await runWithGuard('delete_all', async () => {
      const { data, error } = await supabase.from('voters').select('*')
      if (error) {
        toast.error(error.message)
        return
      }

      exportWorkbook(
        [{ name: 'Backup Before Delete All', rows: (data as Record<string, unknown>[] | null) ?? [] }],
        `backup-before-delete-all-${Date.now()}.xlsx`,
      )

      if (!window.confirm('Backup downloaded. Do you want to permanently delete ALL voter data now?')) {
        return
      }

      const { error: deleteError } = await supabase.from('voters').delete().not('id', 'is', null)
      if (deleteError) {
        toast.error(deleteError.message)
        return
      }

      await supabase.rpc('refresh_dashboard_stats')
      toast.success('All voter data deleted after backup export.')
      window.location.reload()
    })
  }

  const handleDeletePart = async () => {
    await runWithGuard('delete_part', async () => {
      const partNumber = Number.parseInt(partToDelete.trim(), 10)
      if (Number.isNaN(partNumber)) {
        toast.error('Enter a valid part number first.')
        return
      }

      const { data, error } = await supabase.from('voters').select('*').eq('part_no', partNumber)
      if (error) {
        toast.error(error.message)
        return
      }

      if (!data?.length) {
        toast.error('No voters found for selected part.')
        return
      }

      exportWorkbook(
        [{ name: `Part ${partNumber} Backup`, rows: data as Record<string, unknown>[] }],
        `backup-part-${partNumber}-${Date.now()}.xlsx`,
      )

      if (!window.confirm(`Backup downloaded. Delete all voters from part ${partNumber}?`)) {
        return
      }

      const { error: deleteError } = await supabase.from('voters').delete().eq('part_no', partNumber)
      if (deleteError) {
        toast.error(deleteError.message)
        return
      }

      await supabase.rpc('refresh_dashboard_stats')
      toast.success(`Part ${partNumber} data deleted after backup export.`)
      window.location.reload()
    })
  }

  const handlePreviewEpicDisable = async () => {
    await runWithGuard('preview_disable', async () => {
      const epics = parseEpicTokens(disableEpicText)
      if (!epics.length) {
        toast.error('Paste at least one EPIC number.')
        return
      }
      try {
        const preview = await fetchApiJson<BulkDisablePreview>('/api/voters/bulk-disable/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epics }),
        })
        setDisablePreview(preview)
        if (!preview.changeCount) {
          toast.error(preview.notFound.length ? `None found. Missing: ${preview.notFound.slice(0, 8).join(', ')}` : 'Those EPICs are already disabled.')
          return
        }
        toast.success(`Ready to disable ${preview.changeCount} voter${preview.changeCount === 1 ? '' : 's'}. Assignments stay intact.`)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not preview disable.')
      }
    })
  }

  const handleDisableEpics = async () => {
    await runWithGuard('disable_epics', async () => {
      const epics = parseEpicTokens(disableEpicText)
      if (!epics.length) {
        toast.error('Paste at least one EPIC number.')
        return
      }
      try {
        const preview = disablePreview ?? await fetchApiJson<BulkDisablePreview>('/api/voters/bulk-disable/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epics }),
        })
        setDisablePreview(preview)
        if (!preview.changeCount) {
          toast.error('None of those EPICs are active.')
          return
        }
        if (!window.confirm(`Disable ${preview.changeCount} voter${preview.changeCount === 1 ? '' : 's'}? They stay in the database with team-leader assignments intact.`)) {
          return
        }
        const result = await fetchApiJson<BulkDisablePreview>('/api/voters/bulk-disable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epics, reason: 'Removed from electoral roll' }),
        })
        await invalidateVoterCache()
        clearCachedCollection(DASHBOARD_CACHE_KEY)
        setDisableEpicText('')
        setDisablePreview(null)
        toast.success(`Disabled ${result.changeCount} voter${result.changeCount === 1 ? '' : 's'}.`)
        await load()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not disable EPICs.')
      }
    })
  }

  const handlePreviewEpicDelete = async () => {
    await runWithGuard('preview_epics', async () => {
      const epics = parseEpicTokens(epicListText)
      if (!epics.length) {
        toast.error('Paste at least one EPIC number.')
        return
      }
      try {
        const preview = await fetchApiJson<BulkDeletePreview>('/api/voters/bulk-delete/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epics }),
        })
        setEpicPreview(preview)
        if (!preview.deleteCount) {
          toast.error(preview.notFound.length ? `None found. Missing: ${preview.notFound.slice(0, 8).join(', ')}` : 'None of those EPICs were found.')
          return
        }
        toast.success(`Ready: ${preview.deleteCount} voter${preview.deleteCount === 1 ? '' : 's'}, ${preview.wholeFamilies} whole famil${preview.wholeFamilies === 1 ? 'y' : 'ies'}, ${preview.headRewrites.length} head rewrite${preview.headRewrites.length === 1 ? '' : 's'}.`)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not preview EPIC delete.')
      }
    })
  }

  const handleDeleteEpics = async () => {
    await runWithGuard('delete_epics', async () => {
      const epics = parseEpicTokens(epicListText)
      if (!epics.length) {
        toast.error('Paste at least one EPIC number.')
        return
      }
      try {
        const preview = epicPreview ?? await fetchApiJson<BulkDeletePreview>('/api/voters/bulk-delete/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epics }),
        })
        setEpicPreview(preview)
        if (!preview.deleteCount) {
          toast.error('None of those EPICs were found.')
          return
        }

        exportWorkbook(
          [
            { name: 'Voters to Delete', rows: preview.voters },
            { name: 'Head Rewrites', rows: preview.headRewrites },
            { name: 'Not Found', rows: preview.notFound.map((epic) => ({ epic_no: epic })) },
          ],
          `backup-before-epic-delete-${Date.now()}.xlsx`,
        )

        const rewriteNote = preview.headRewrites.length
          ? `\n${preview.headRewrites.length} family head${preview.headRewrites.length === 1 ? '' : 's'} will be rewritten first.`
          : ''
        if (!window.confirm(`Backup downloaded. Permanently delete ${preview.deleteCount} voter${preview.deleteCount === 1 ? '' : 's'} (${preview.wholeFamilies} whole famil${preview.wholeFamilies === 1 ? 'y' : 'ies'})?${rewriteNote}`)) {
          return
        }

        const result = await fetchApiJson<BulkDeletePreview>('/api/voters/bulk-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epics }),
        })
        await invalidateVoterCache()
        clearCachedCollection(DASHBOARD_CACHE_KEY)
        clearTeamLeadersListCache()
        clearTeamLeaderDetailCache()
        clearUnassignedDataCache()
        setEpicListText('')
        setEpicPreview(null)
        toast.success(`Deleted ${result.deleteCount} voter${result.deleteCount === 1 ? '' : 's'}.`)
        await load()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not delete EPICs.')
      }
    })
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Constituency briefing: roll totals, distributions, and exports."
        action={
          isAdminAreaAllowed ? (
            <Button variant="secondary" onClick={() => navigate('/voters/new')}>
              <UserPlus className="h-4 w-4" />
              Add voter
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="h-24 rounded-xl border border-line bg-white shadow-soft" />
          <div className="h-24 rounded-xl border border-line bg-white shadow-soft" />
          <div className="h-24 rounded-xl border border-line bg-white shadow-soft" />
          <div className="h-24 rounded-xl border border-line bg-white shadow-soft" />
        </div>
      ) : null}

      <section className="md:hidden">
        <form
          onSubmit={handleMobileSearch}
          className="flex items-center gap-2 rounded-xl border border-line bg-white p-2 shadow-soft"
        >
          <Search className="ml-1 h-5 w-5 shrink-0 text-ink-tertiary" />
          <input
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder="Search voters by name, EPIC, part..."
            value={mobileSearch}
            onChange={(event) => setMobileSearch(event.target.value)}
            inputMode="search"
          />
          <Button type="submit" size="mobile">
            Search
          </Button>
        </form>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {mobileQuickActions.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.path}
                type="button"
                onClick={() => navigate(action.path)}
                className="flex flex-col items-center gap-2 rounded-xl border border-line bg-white p-3 text-center shadow-soft"
              >
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-xs font-semibold text-ink">{action.label}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2">
          {compactStats.map((stat) => (
            <div key={stat.label} className="rounded-xl border border-line bg-white p-2 text-center shadow-soft">
              <p className="text-base font-semibold tabular-nums text-ink">{stat.value}</p>
              <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-ink-tertiary">{stat.label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="hidden gap-3 sm:grid-cols-2 xl:grid-cols-4 md:grid">
        <StatCard
          title="Total"
          value={formatNumber(totalVoters)}
          meta={percentOf(totalVoters, totalVoters)}
          featured
          tone="brand"
          icon={<Users className="h-4 w-4" />}
        />
        <StatCard title="Male" value={formatNumber(maleCount)} meta={percentOf(maleCount, totalVoters)} tone="info" />
        <StatCard title="Female" value={formatNumber(femaleCount)} meta={percentOf(femaleCount, totalVoters)} tone="success" />
        <StatCard title="Other" value={formatNumber(otherCount)} meta={percentOf(otherCount, totalVoters)} />
      </section>

      <section className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-2.5 shadow-soft">
        <select
          className="h-10 min-w-[180px] rounded-lg border border-line bg-white px-3 text-sm text-ink outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          value={reportType}
          aria-label="Report type"
          title="Report type"
          onChange={(event) => {
            setReportType(event.target.value as ReportType)
            setSelectedReportKey(null)
          }}
        >
          <option value="religion">Religion Distribution</option>
          <option value="gender">Gender Distribution</option>
          <option value="state">State Distribution</option>
          <option value="part">Part Distribution</option>
          <option value="ward">Ward Distribution</option>
          <option value="age_band">Age Band Distribution</option>
        </select>
        <Button variant="secondary" onClick={handleExportReports}>
          Export reports
        </Button>
        {isAdminAreaAllowed ? (
          <>
            <Button variant="secondary" onClick={() => void handleExportAll()} disabled={runningAction === 'export_all'} loading={runningAction === 'export_all'}>
              Export all
            </Button>
            <Button variant="secondary" onClick={() => void handlePartwiseReport()} disabled={runningAction === 'part_report'} loading={runningAction === 'part_report'}>
              Part-wise report
            </Button>
            <Button variant="secondary" onClick={() => void handleBackupAllApplicationData()} disabled={runningAction === 'backup_all'} loading={runningAction === 'backup_all'}>
              Export full backup
            </Button>
          </>
        ) : null}
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl border border-line bg-white p-5 shadow-soft">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-[15px] font-semibold tracking-[-0.02em] text-ink">Religion</h2>
            <p className="text-xs text-ink-tertiary">Share of roll</p>
          </div>
          <div className="mt-3 h-72">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={religionRows} dataKey="count" nameKey="label" innerRadius={58} outerRadius={95} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                  {religionRows.map((row) => (
                    <Cell key={row.key} fill={colorForLabel(row.label)} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-1 space-y-1.5 text-sm text-ink-secondary">
            {religionRows.slice(0, 8).map((row) => (
              <li key={row.key} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorForLabel(row.label) }} />
                  <span className="truncate">{row.label}</span>
                </span>
                <span className="tabular-nums font-medium text-ink">{formatNumber(row.count)}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="rounded-xl border border-line bg-white p-5 shadow-soft">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-[15px] font-semibold tracking-[-0.02em] text-ink">Gender</h2>
            <p className="text-xs text-ink-tertiary">Share of roll</p>
          </div>
          <div className="mt-3 h-72">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={genderRows} dataKey="count" nameKey="label" innerRadius={58} outerRadius={95} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                  {genderRows.map((row) => (
                    <Cell key={row.key} fill={genderColor(row.label)} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-1 space-y-1.5 text-sm text-ink-secondary">
            {genderRows.map((row) => (
              <li key={row.key} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: genderColor(row.label) }} />
                  <span className="truncate">{row.label}</span>
                </span>
                <span className="tabular-nums font-medium text-ink">{formatNumber(row.count)}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="rounded-xl border border-line bg-white p-5 shadow-soft lg:col-span-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-[15px] font-semibold tracking-[-0.02em] text-ink">Age bands</h2>
            <p className="text-xs text-ink-tertiary">Voters by age group</p>
          </div>
          <div className="mt-3 h-72">
            <ResponsiveContainer>
              <BarChart data={ageBandRows} barCategoryGap={18}>
                <CartesianGrid vertical={false} stroke="#e4e8f1" strokeDasharray="3 6" />
                <XAxis dataKey="label" tick={{ fill: '#6a7892', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#6a7892', fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip />
                <Bar dataKey="count" fill="#4F46E5" radius={[6, 6, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>
      </section>

      {isAdminAreaAllowed ? (
        <section className="mt-4 hidden md:block">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => navigate('/admin/import-data')}>Import data</Button>
            <Button variant="secondary" onClick={() => navigate('/admin/users')}>Users</Button>
            <Button variant="secondary" onClick={() => navigate('/admin/wards')}>Wards</Button>
            <Button variant="secondary" onClick={() => navigate('/admin/activity-logs')}>Activity</Button>
          </div>

          <div className="mt-4 rounded-xl border border-[var(--danger-border)] bg-white p-4 shadow-soft">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left"
              onClick={() => setRollMaintenanceOpen((open) => !open)}
            >
              <span>
                <span className="block text-sm font-semibold text-ink">Roll maintenance</span>
                <span className="mt-0.5 block text-xs text-ink-tertiary">Disable or delete voters. Confirm before each action.</span>
              </span>
              <span className="text-xs font-semibold text-ink-secondary">{rollMaintenanceOpen ? 'Hide' : 'Show'}</span>
            </button>
            {rollMaintenanceOpen ? (
              <div className="mt-4 space-y-4">
            <Button variant="danger" onClick={() => void handleDeleteAll()} disabled={runningAction === 'delete_all'} loading={runningAction === 'delete_all'}>
              Delete all data
            </Button>

            <div className="rounded-xl border border-line p-3">
              <p className="font-semibold text-ink">Delete part data</p>
              <p className="mt-1 text-sm text-ink-secondary">Remove specific part voters</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  className="h-10 rounded-lg border border-line px-3 text-sm"
                  placeholder="Part number"
                  value={partToDelete}
                  onChange={(event) => setPartToDelete(event.target.value)}
                />
                <Button variant="danger" onClick={() => void handleDeletePart()} disabled={runningAction === 'delete_part'} loading={runningAction === 'delete_part'}>
                  Delete part data
                </Button>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--warning-border)] bg-[var(--warning-fill)] p-3">
              <p className="font-semibold text-ink">Disable by EPIC (preferred)</p>
              <p className="mt-1 text-sm text-ink-secondary">
                Hide voters removed from the roll without deleting them. Family, groups, and team-leader assignments stay.
              </p>
              <textarea
                className="mt-3 min-h-28 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
                placeholder={'ABC1234567\nXYZ9876543'}
                value={disableEpicText}
                onChange={(event) => {
                  setDisableEpicText(event.target.value)
                  setDisablePreview(null)
                }}
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="secondary" onClick={() => void handlePreviewEpicDisable()} disabled={runningAction === 'preview_disable' || runningAction === 'disable_epics'} loading={runningAction === 'preview_disable'}>
                  Preview
                </Button>
                <Button variant="danger" onClick={() => void handleDisableEpics()} disabled={runningAction === 'disable_epics' || runningAction === 'preview_disable'} loading={runningAction === 'disable_epics'}>
                  Disable EPICs
                </Button>
              </div>
              {disablePreview ? (
                <div className="mt-3 rounded-lg border border-line bg-white p-3 text-sm text-ink-secondary">
                  <p>
                    {disablePreview.changeCount} voter{disablePreview.changeCount === 1 ? '' : 's'} will be disabled
                    {disablePreview.alreadyDisabled ? ` · ${disablePreview.alreadyDisabled} already disabled` : ''}
                    {disablePreview.notFound.length ? ` · ${disablePreview.notFound.length} not found` : ''}.
                  </p>
                  {disablePreview.notFound.length ? (
                    <p className="mt-2 text-[var(--warning)]">Not found: {disablePreview.notFound.slice(0, 12).join(', ')}{disablePreview.notFound.length > 12 ? '…' : ''}</p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-line p-3">
              <p className="font-semibold text-ink">Bulk delete by EPIC (permanent)</p>
              <p className="mt-1 text-sm text-ink-secondary">
                Permanently remove voters. Prefer Disable above. If a family head is listed and members remain, the family is rewritten first.
              </p>
              <textarea
                className="mt-3 min-h-28 w-full rounded-lg border border-line px-3 py-2 text-sm"
                placeholder={'ABC1234567\nXYZ9876543'}
                value={epicListText}
                onChange={(event) => {
                  setEpicListText(event.target.value)
                  setEpicPreview(null)
                }}
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="secondary" onClick={() => void handlePreviewEpicDelete()} disabled={runningAction === 'preview_epics' || runningAction === 'delete_epics'} loading={runningAction === 'preview_epics'}>
                  Preview
                </Button>
                <Button variant="danger" onClick={() => void handleDeleteEpics()} disabled={runningAction === 'delete_epics' || runningAction === 'preview_epics'} loading={runningAction === 'delete_epics'}>
                  Delete EPICs
                </Button>
              </div>
              {epicPreview ? (
                <div className="mt-3 rounded-lg border border-line bg-muted p-3 text-sm text-ink-secondary">
                  <p>
                    {epicPreview.deleteCount} voter{epicPreview.deleteCount === 1 ? '' : 's'} will be deleted
                    {' '}({epicPreview.wholeFamilies} whole famil{epicPreview.wholeFamilies === 1 ? 'y' : 'ies'}, {epicPreview.memberOnly} member-only, {epicPreview.headRewrites.length} head rewrite{epicPreview.headRewrites.length === 1 ? '' : 's'}).
                  </p>
                  {epicPreview.headRewrites.length ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {epicPreview.headRewrites.slice(0, 8).map((rewrite) => (
                        <li key={`${rewrite.fromEpic}-${rewrite.toEpic}`}>
                          {rewrite.fromName} ({rewrite.fromEpic}) → {rewrite.toName} ({rewrite.toEpic}), {rewrite.remainingCount} remaining
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {epicPreview.notFound.length ? (
                    <p className="mt-2 text-[var(--warning)]">Not found: {epicPreview.notFound.slice(0, 12).join(', ')}{epicPreview.notFound.length > 12 ? '…' : ''}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}
