import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BarChart3,
  BellRing,
  Building2,
  CalendarClock,
  Camera,
  CheckSquare,
  ChevronDown,
  Copy,
  Database,
  FileCog,
  Home,
  LogOut,
  Map,
  MapPin,
  MapPinned,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
  Tags,
  User,
  Users,
  UsersRound,
  BriefcaseBusiness,
  FolderOpen,
  CalendarDays,
  UserCheck,
  UserX,
  Vote,
  X,
} from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useFieldAccess } from '../../hooks/useFieldAccess'
import { useFieldOutboxCount } from '../../hooks/useFieldOutbox'
import { cn } from '../../lib/utils'
import { Button } from '../../components/ui/Button'

interface NavItem {
  label: string
  path: string
  icon: typeof Home
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const workspaceItems: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', icon: Home },
  { label: 'Voters', path: '/voters', icon: Users },
  { label: 'Disabled voters', path: '/voters/disabled', icon: UserX },
  { label: 'Duplicate voters', path: '/voters/duplicates', icon: Copy },
  { label: 'New voters', path: '/voters/new-list', icon: Camera },
  { label: 'Families', path: '/families', icon: UsersRound },
  { label: 'Tenants', path: '/tenants', icon: Building2 },
  { label: 'Groups', path: '/groups', icon: FolderOpen },
  { label: 'Team Leaders', path: '/team-leaders', icon: UserCheck },
  { label: 'Places', path: '/places', icon: MapPinned },
  { label: 'Jobs', path: '/jobs', icon: BriefcaseBusiness },
  { label: 'Meetings', path: '/meetings', icon: CalendarDays },
  { label: 'Birthdays', path: '/birthdays', icon: CalendarClock },
  { label: 'Insights', path: '/insights', icon: BarChart3 },
  { label: 'Attendance', path: '/booth/attendance', icon: CheckSquare },
  { label: 'Booth turnout', path: '/booth/insights', icon: Vote },
  { label: 'Geo-tag', path: '/field/geotag', icon: MapPin },
  { label: 'Family map', path: '/field/map', icon: Map },
  { label: 'Category Status', path: '/category-status', icon: Tags },
]

const fieldItems: NavItem[] = [
  { label: 'Attendance', path: '/booth/attendance', icon: CheckSquare },
  { label: 'Geo-tag', path: '/field/geotag', icon: MapPin },
  { label: 'Map', path: '/field/map', icon: Map },
  { label: 'Turnout', path: '/booth/insights', icon: Vote },
]

const adminItems: NavItem[] = [
  { label: 'Import Data', path: '/admin/import-data', icon: Database },
  { label: 'Wards', path: '/admin/wards', icon: MapPinned },
  { label: 'Booths', path: '/admin/booths', icon: Vote },
  { label: 'Users', path: '/admin/users', icon: ShieldCheck },
  { label: 'Custom Fields', path: '/admin/custom-fields', icon: FileCog },
  { label: 'Activity Logs', path: '/admin/activity-logs', icon: BellRing },
]

const workspaceGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', path: '/dashboard', icon: Home },
      { label: 'Insights', path: '/insights', icon: BarChart3 },
      { label: 'Category Status', path: '/category-status', icon: Tags },
    ],
  },
  {
    label: 'Roll',
    items: [
      { label: 'Voters', path: '/voters', icon: Users },
      { label: 'Disabled voters', path: '/voters/disabled', icon: UserX },
      { label: 'Duplicate voters', path: '/voters/duplicates', icon: Copy },
      { label: 'New voters', path: '/voters/new-list', icon: Camera },
      { label: 'Families', path: '/families', icon: UsersRound },
      { label: 'Tenants', path: '/tenants', icon: Building2 },
      { label: 'Birthdays', path: '/birthdays', icon: CalendarClock },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { label: 'Groups', path: '/groups', icon: FolderOpen },
      { label: 'Team Leaders', path: '/team-leaders', icon: UserCheck },
      { label: 'Places', path: '/places', icon: MapPinned },
      { label: 'Jobs', path: '/jobs', icon: BriefcaseBusiness },
    ],
  },
  {
    label: 'Engagement',
    items: [{ label: 'Meetings', path: '/meetings', icon: CalendarDays }],
  },
  {
    label: 'Field',
    items: [
      { label: 'Attendance', path: '/booth/attendance', icon: CheckSquare },
      { label: 'Booth turnout', path: '/booth/insights', icon: Vote },
      { label: 'Geo-tag', path: '/field/geotag', icon: MapPin },
      { label: 'Family map', path: '/field/map', icon: Map },
    ],
  },
]

const PAGE_TITLES: Array<{ match: (path: string) => boolean; title: string }> = [
  { match: (path) => path === '/dashboard', title: 'Dashboard' },
  { match: (path) => path === '/voters/new', title: 'Add voter' },
  { match: (path) => path === '/voters/disabled', title: 'Disabled voters' },
  { match: (path) => path === '/voters/duplicates', title: 'Duplicate voters' },
  { match: (path) => path === '/voters/new-list', title: 'New voters' },
  { match: (path) => path.startsWith('/voters'), title: 'Voters' },
  { match: (path) => path.startsWith('/families'), title: 'Families' },
  { match: (path) => path.startsWith('/tenants'), title: 'Tenants' },
  { match: (path) => path.startsWith('/groups'), title: 'Groups' },
  { match: (path) => path === '/team-leaders/unassigned', title: 'Unassigned families' },
  { match: (path) => path === '/team-leaders/stats', title: 'Team leader stats' },
  { match: (path) => path.startsWith('/team-leaders'), title: 'Team leaders' },
  { match: (path) => path.startsWith('/places'), title: 'Places' },
  { match: (path) => path.startsWith('/presence-notes'), title: 'Presence notes' },
  { match: (path) => path.startsWith('/jobs'), title: 'Jobs' },
  { match: (path) => path.startsWith('/meetings'), title: 'Meetings' },
  { match: (path) => path.startsWith('/not-yet-invited'), title: 'Not yet invited' },
  { match: (path) => path.startsWith('/birthdays'), title: 'Birthdays' },
  { match: (path) => path.startsWith('/insights'), title: 'Insights' },
  { match: (path) => path.startsWith('/category-status'), title: 'Category status' },
  { match: (path) => path.startsWith('/booth/attendance'), title: 'Attendance' },
  { match: (path) => path.startsWith('/booth/insights'), title: 'Booth turnout' },
  { match: (path) => path.startsWith('/field/geotag'), title: 'Geo-tag' },
  { match: (path) => path.startsWith('/field/map'), title: 'Family map' },
  { match: (path) => path.startsWith('/admin/import-data'), title: 'Import data' },
  { match: (path) => path.startsWith('/admin/wards'), title: 'Wards' },
  { match: (path) => path.startsWith('/admin/booths'), title: 'Booths' },
  { match: (path) => path.startsWith('/admin/users'), title: 'Users' },
  { match: (path) => path.startsWith('/admin/custom-fields'), title: 'Custom fields' },
  { match: (path) => path.startsWith('/admin/activity-logs'), title: 'Activity logs' },
  { match: (path) => path.startsWith('/account/profile'), title: 'Profile' },
  { match: (path) => path.startsWith('/account/settings'), title: 'Settings' },
]

function pageTitleFor(pathname: string): string {
  return PAGE_TITLES.find((entry) => entry.match(pathname))?.title ?? 'VoterData'
}

function SideNavItem({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.path}
      end={item.path === '/voters'}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium tracking-[-0.01em] transition',
          isActive
            ? 'bg-brand-50 text-brand-700 shadow-inset'
            : 'text-ink-secondary hover:bg-muted/80 hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-[image:var(--kpi-hairline)]" /> : null}
          <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-brand-600' : 'text-ink-tertiary group-hover:text-ink-secondary')} />
          <span className="truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  )
}

function MoreSheetRow({ item, onClose }: { item: NavItem; onClose: () => void }) {
  const Icon = item.icon
  return (
    <Link
      to={item.path}
      onClick={onClose}
      className="flex h-12 items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink-secondary active:bg-muted"
    >
      <Icon className="h-5 w-5 text-ink-tertiary" />
      {item.label}
    </Link>
  )
}

export function AppLayout() {
  const { profile, signOut, isAdminAreaAllowed } = useAuth()
  const fieldAccess = useFieldAccess()
  const pendingSync = useFieldOutboxCount()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const navigate = useNavigate()
  const location = useLocation()

  const fieldOnly = fieldAccess.isFieldOnly
  const visibleWorkspace = fieldOnly
    ? fieldItems.filter((item) => {
        if (item.path === '/booth/attendance') return fieldAccess.isBoothAgent || fieldAccess.isAdmin
        if (item.path === '/field/geotag') return fieldAccess.isFieldLeader || fieldAccess.isAdmin
        if (item.path === '/field/map') return fieldAccess.isFieldLeader || fieldAccess.isAdmin
        if (item.path === '/booth/insights') return fieldAccess.isBoothAgent || fieldAccess.isAdmin
        return true
      })
    : workspaceItems
  const visibleAdmin = fieldOnly ? [] : adminItems

  const mobilePrimaryItems = fieldOnly
    ? visibleWorkspace.slice(0, 4)
    : workspaceItems.filter((item) => item.path === '/dashboard' || item.path === '/voters' || item.path === '/families')

  const mobileMoreWorkspace = fieldOnly
    ? visibleWorkspace.slice(4)
    : workspaceItems.filter((item) => item.path !== '/dashboard' && item.path !== '/voters' && item.path !== '/families')

  const moreItemPaths = [
    ...mobileMoreWorkspace.map((item) => item.path),
    ...(isAdminAreaAllowed && !fieldOnly ? adminItems.map((item) => item.path) : []),
    '/account/profile',
    '/account/settings',
  ]
  const isMoreActive = moreItemPaths.includes(location.pathname)

  useEffect(() => {
    const saved = window.localStorage.getItem('vote:sidebar-visible')
    if (saved === 'false') {
      setSidebarVisible(false)
    }
  }, [])

  const fieldHome = visibleWorkspace[0]?.path

  useEffect(() => {
    if (!fieldOnly || fieldAccess.loading || !fieldHome) return
    if (location.pathname === '/' || location.pathname === '/dashboard') {
      navigate(fieldHome, { replace: true })
    }
  }, [fieldOnly, fieldAccess.loading, location.pathname, fieldHome, navigate])

  useEffect(() => {
    setMobileOpen(false)
    setMoreOpen(false)
    setMenuOpen(false)
  }, [location.pathname])

  const toggleSidebar = () => {
    setSidebarVisible((current) => {
      const next = !current
      window.localStorage.setItem('vote:sidebar-visible', String(next))
      return next
    })
  }

  const initials = !profile?.full_name
    ? (profile?.email.slice(0, 2).toUpperCase() ?? 'NA')
    : profile.full_name
        .split(' ')
        .map((chunk) => chunk.charAt(0).toUpperCase())
        .slice(0, 2)
        .join('')

  const handleLogout = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  const handleSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const term = searchQuery.trim()
    navigate(term ? `/voters?q=${encodeURIComponent(term)}` : '/voters')
  }

  const currentTitle = pageTitleFor(location.pathname)

  const groupedNav = useMemo(() => {
    if (fieldOnly) {
      return [{ label: 'Field', items: visibleWorkspace }]
    }
    return workspaceGroups
  }, [fieldOnly, visibleWorkspace])

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="flex min-h-screen">
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-40 flex w-[15.5rem] flex-col border-r border-line bg-white/95 transition md:static md:translate-x-0',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
            !sidebarVisible && 'md:hidden',
          )}
        >
          <Link to={fieldOnly ? (fieldHome ?? '/dashboard') : '/dashboard'} className="flex h-16 shrink-0 items-center gap-2.5 px-4">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[image:var(--kpi-hairline)] text-sm font-semibold text-white shadow-sm">
              V
            </span>
            <span className="truncate font-display text-[15px] font-semibold tracking-[-0.02em] text-ink">VoterData</span>
          </Link>

          <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-6 pt-1">
            {groupedNav.map((group) => (
              <div key={group.label} className="space-y-0.5">
                <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                  {group.label}
                </p>
                {group.items.map((item) => (
                  <SideNavItem item={item} key={item.path} />
                ))}
              </div>
            ))}

            {isAdminAreaAllowed && visibleAdmin.length ? (
              <div className="space-y-1">
                <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                  Admin
                </p>
                {visibleAdmin.map((item) => (
                  <SideNavItem item={item} key={item.path} />
                ))}
              </div>
            ) : null}
          </nav>
        </aside>

        {mobileOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-30 bg-slate-900/30 md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-line bg-white/92 px-4 shadow-header backdrop-blur-md md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-line text-ink-secondary md:hidden"
                onClick={() => setMobileOpen((open) => !open)}
                aria-label={mobileOpen ? 'Hide sidebar' : 'Show sidebar'}
                title={mobileOpen ? 'Hide sidebar' : 'Show sidebar'}
              >
                {mobileOpen ? <PanelLeftClose className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
              <button
                type="button"
                className="hidden h-10 w-10 items-center justify-center rounded-lg border border-line text-ink-secondary md:inline-flex"
                onClick={toggleSidebar}
                aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
                title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
              >
                {sidebarVisible ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
              </button>
              <h1 className="truncate font-display text-[15px] font-semibold tracking-[-0.02em] text-ink">{currentTitle}</h1>
              {pendingSync > 0 ? (
                <span className="hidden h-7 items-center rounded-md border border-[var(--warning-border)] bg-[var(--warning-fill)] px-2 text-xs font-semibold text-[var(--warning)] sm:inline-flex">
                  {pendingSync} pending sync
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              {!fieldOnly ? (
                <form onSubmit={handleSearch} className="relative hidden min-w-[200px] md:block lg:min-w-[280px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
                  <input
                    className="h-10 w-full rounded-lg border border-line bg-muted/50 pl-9 pr-3 text-sm text-ink outline-none transition placeholder:text-ink-tertiary focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-200"
                    placeholder="Search voters"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    aria-label="Search voters"
                  />
                </form>
              ) : null}

              <div className="relative">
                <button
                  type="button"
                  className="flex h-10 items-center gap-3 rounded-lg border border-line px-2.5"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[image:var(--kpi-hairline)] text-[11px] font-semibold text-white">
                    {initials}
                  </span>
                  <span className="hidden text-left text-xs sm:block">
                    <span className="block font-semibold text-ink">{profile?.full_name ?? 'User'}</span>
                    <span className="block capitalize text-ink-tertiary">{profile?.role ?? 'user'}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 text-ink-tertiary" />
                </button>

                {menuOpen ? (
                  <div className="absolute right-0 mt-2 w-52 rounded-xl border border-line bg-white p-1.5 shadow-popover">
                    <NavLink
                      to="/account/profile"
                      className="flex h-10 items-center gap-2 rounded-lg px-3 text-sm text-ink-secondary hover:bg-muted"
                      onClick={() => setMenuOpen(false)}
                    >
                      <User className="h-4 w-4" />
                      Profile
                    </NavLink>
                    <NavLink
                      to="/account/settings"
                      className="flex h-10 items-center gap-2 rounded-lg px-3 text-sm text-ink-secondary hover:bg-muted"
                      onClick={() => setMenuOpen(false)}
                    >
                      <Settings className="h-4 w-4" />
                      Settings
                    </NavLink>
                    <button
                      type="button"
                      className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-[var(--danger)] hover:bg-[var(--danger-fill)]"
                      onClick={handleLogout}
                    >
                      <LogOut className="h-4 w-4" />
                      Log out
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-5 pb-24 md:px-6 md:py-6 md:pb-6">
            <Outlet />
          </main>

          <nav
            className={cn(
              'fixed inset-x-3 bottom-3 z-40 grid gap-1 rounded-2xl border border-line bg-white/95 p-1.5 shadow-popover backdrop-blur-md md:hidden',
              fieldOnly ? 'grid-cols-5' : 'grid-cols-4',
            )}
          >
            {mobilePrimaryItems.map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    cn(
                      'flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-ink-tertiary transition',
                      isActive && 'bg-brand-50 text-brand-700',
                    )
                  }
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-[10px] font-semibold leading-none">{item.label}</span>
                </NavLink>
              )
            })}
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              aria-label="More options"
              aria-expanded={moreOpen}
              className={cn(
                'flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-ink-tertiary transition',
                isMoreActive && 'bg-brand-50 text-brand-700',
              )}
            >
              <MoreHorizontal className="h-5 w-5" />
              <span className="text-[10px] font-semibold leading-none">More</span>
            </button>
          </nav>

          {moreOpen ? (
            <div className="fixed inset-0 z-50 md:hidden">
              <button
                type="button"
                className="absolute inset-0 bg-slate-900/40"
                onClick={() => setMoreOpen(false)}
                aria-label="Close more menu"
              />
              <div className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-white p-4 pb-8">
                <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-line-strong" />
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-lg font-semibold text-ink">More</p>
                  <Button variant="icon" onClick={() => setMoreOpen(false)} aria-label="Close">
                    <X className="h-5 w-5" />
                  </Button>
                </div>

                {mobileMoreWorkspace.length ? (
                  <>
                    <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                      Workspace
                    </p>
                    <div className="space-y-0.5">
                      {mobileMoreWorkspace.map((item) => (
                        <MoreSheetRow key={item.path} item={item} onClose={() => setMoreOpen(false)} />
                      ))}
                    </div>
                  </>
                ) : null}

                {isAdminAreaAllowed && visibleAdmin.length ? (
                  <>
                    <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                      Admin
                    </p>
                    <div className="space-y-0.5">
                      {adminItems.map((item) => (
                        <MoreSheetRow key={item.path} item={item} onClose={() => setMoreOpen(false)} />
                      ))}
                    </div>
                  </>
                ) : null}

                <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                  Account
                </p>
                <div className="space-y-0.5">
                  <MoreSheetRow
                    item={{ label: 'Profile', path: '/account/profile', icon: User }}
                    onClose={() => setMoreOpen(false)}
                  />
                  <MoreSheetRow
                    item={{ label: 'Settings', path: '/account/settings', icon: Settings }}
                    onClose={() => setMoreOpen(false)}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      void handleLogout()
                    }}
                    className="flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-[var(--danger)] active:bg-[var(--danger-fill)]"
                  >
                    <LogOut className="h-5 w-5" />
                    Log out
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
