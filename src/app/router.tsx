import { Navigate, Outlet, createBrowserRouter } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { AppLayout } from './layouts/AppLayout'
import { LoginPage } from '../pages/auth/LoginPage'
import { DashboardPage } from '../pages/workspace/DashboardPage'
import { VotersPage } from '../pages/workspace/VotersPage'
import { DisabledVotersPage } from '../pages/workspace/DisabledVotersPage'
import { DuplicateVotersPage } from '../pages/workspace/DuplicateVotersPage'
import { NewVotersPage } from '../pages/workspace/NewVotersPage'
import { AddVoterPage } from '../pages/workspace/AddVoterPage'
import { FamiliesPage } from '../pages/workspace/FamiliesPage'
import { TenantsPage } from '../pages/workspace/TenantsPage'
import { BirthdaysPage } from '../pages/workspace/BirthdaysPage'
import { InsightsPage } from '../pages/workspace/InsightsPage'
import { GroupsPage } from '../pages/workspace/GroupsPage'
import { GroupDetailPage } from '../pages/workspace/GroupDetailPage'
import { TeamLeadersPage } from '../pages/workspace/TeamLeadersPage'
import { TeamLeaderDetailPage } from '../pages/workspace/TeamLeaderDetailPage'
import { UnassignedFamiliesPage } from '../pages/workspace/UnassignedFamiliesPage'
import { TeamLeaderStatsPage } from '../pages/workspace/TeamLeaderStatsPage'
import { PlacesPage } from '../pages/workspace/PlacesPage'
import { PresenceNotesPage } from '../pages/workspace/PresenceNotesPage'
import { CategoryStatusPage } from '../pages/workspace/CategoryStatusPage'
import { JobsPage } from '../pages/workspace/JobsPage'
import { MeetingsPage } from '../pages/workspace/MeetingsPage'
import { MeetingsDetailPage } from '../pages/workspace/MeetingsDetailPage'
import { GlobalNotYetInvitedPage } from '../pages/workspace/GlobalNotYetInvitedPage'
import { GlobalNotYetInvitedPartPage } from '../pages/workspace/GlobalNotYetInvitedPartPage'
import { ImportDataPage } from '../pages/admin/ImportDataPage'
import { UsersPage } from '../pages/admin/UsersPage'
import { CustomFieldsPage } from '../pages/admin/CustomFieldsPage'
import { ActivityLogsPage } from '../pages/admin/ActivityLogsPage'
import { WardsPage } from '../pages/admin/WardsPage'
import { ProfilePage } from '../pages/account/ProfilePage'
import { SettingsPage } from '../pages/account/SettingsPage'
import { BoothAttendancePage } from '../pages/booth/BoothAttendancePage'
import { BoothInsightsPage } from '../pages/booth/BoothInsightsPage'
import { FieldGeotagPage } from '../pages/field/FieldGeotagPage'
import { FieldMapPage } from '../pages/field/FieldMapPage'
import { BoothConfigPage } from '../pages/admin/BoothConfigPage'

function RequireAuth() {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="flex h-16 items-center gap-3 border-b border-line bg-white px-6">
          <div className="h-8 w-8 rounded-lg bg-muted" />
          <div className="h-4 w-28 rounded bg-muted" />
        </div>
        <div className="px-6 py-6">
          <div className="h-7 w-40 rounded bg-muted" />
          <div className="mt-2 h-4 w-64 rounded bg-muted" />
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="h-24 rounded-xl border border-line bg-white" />
            <div className="h-24 rounded-xl border border-line bg-white" />
            <div className="h-24 rounded-xl border border-line bg-white" />
            <div className="h-24 rounded-xl border border-line bg-white" />
          </div>
        </div>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}

function RequireAdminRoutes() {
  const { isAdminAreaAllowed } = useAuth()

  if (!isAdminAreaAllowed) {
    return <Navigate to="/dashboard" replace />
  }

  return <Outlet />
}

export const router = createBrowserRouter(
  [
    {
    path: '/login',
    element: <LoginPage />,
    },
    {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          {
            path: '/',
            element: <Navigate to="/dashboard" replace />,
          },
          {
            path: '/dashboard',
            element: <DashboardPage />,
          },
          {
            path: '/voters',
            element: <VotersPage />,
          },
          {
            path: '/voters/disabled',
            element: <DisabledVotersPage />,
          },
          {
            path: '/voters/duplicates',
            element: <DuplicateVotersPage />,
          },
          {
            path: '/voters/new-list',
            element: <NewVotersPage />,
          },
          {
            path: '/voters/new',
            element: <AddVoterPage />,
          },
          {
            path: '/families',
            element: <FamiliesPage />,
          },
          {
            path: '/tenants',
            element: <TenantsPage />,
          },
          {
            path: '/birthdays',
            element: <BirthdaysPage />,
          },
          {
            path: '/insights',
            element: <InsightsPage />,
          },
          {
            path: '/category-status',
            element: <CategoryStatusPage />,
          },
          {
            path: '/groups',
            element: <GroupsPage />,
          },
          {
            path: '/groups/:groupId',
            element: <GroupDetailPage />,
          },
          {
            path: '/team-leaders',
            element: <TeamLeadersPage />,
          },
          {
            path: '/team-leaders/unassigned',
            element: <UnassignedFamiliesPage />,
          },
          {
            path: '/team-leaders/stats',
            element: <TeamLeaderStatsPage />,
          },
          {
            path: '/places',
            element: <PlacesPage />,
          },
          {
            path: '/presence-notes',
            element: <PresenceNotesPage />,
          },
          {
            path: '/team-leaders/:leaderId',
            element: <TeamLeaderDetailPage />,
          },
          {
            path: '/jobs',
            element: <JobsPage />,
          },
          {
            path: '/meetings',
            element: <MeetingsPage />,
          },
          {
            path: '/meetings/:id',
            element: <MeetingsDetailPage />,
          },
          {
            path: '/not-yet-invited',
            element: <GlobalNotYetInvitedPage />,
          },
          {
            path: '/not-yet-invited/part/:partNo',
            element: <GlobalNotYetInvitedPartPage />,
          },
          {
            path: '/booth/attendance',
            element: <BoothAttendancePage />,
          },
          {
            path: '/booth/insights',
            element: <BoothInsightsPage />,
          },
          {
            path: '/field/geotag',
            element: <FieldGeotagPage />,
          },
          {
            path: '/field/map',
            element: <FieldMapPage />,
          },
          {
            path: '/account/profile',
            element: <ProfilePage />,
          },
          {
            path: '/account/settings',
            element: <SettingsPage />,
          },
          {
            path: '/admin',
            element: <RequireAdminRoutes />,
            children: [
              {
                path: 'import-data',
                element: <ImportDataPage />,
              },
              {
                path: 'users',
                element: <UsersPage />,
              },
              {
                path: 'custom-fields',
                element: <CustomFieldsPage />,
              },
              {
                path: 'activity-logs',
                element: <ActivityLogsPage />,
              },
              {
                path: 'wards',
                element: <WardsPage />,
              },
              {
                path: 'booths',
                element: <BoothConfigPage />,
              },
            ],
          },
        ],
      },
    ],
    },
  ],
)
