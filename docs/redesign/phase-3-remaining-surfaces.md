# Phase 3 — Remaining surfaces, field tools, admin, polish

You are implementing Phase 3 of the VoterData UI redesign. Phases 1 and 2 are assumed complete (indigo tokens, Inter, `Button` / `TextField` / `Select` / `Dialog`, grouped shell, Dashboard briefing, Voters/Families toolbars, Settings wiring).

This phase brings every remaining page onto the same system and does a leftover sweep. Visual CSS/JSX only. Do not modify database schemas, Supabase/D1 queries, business logic, authentication, permissions, outbox sync, import chunk loop, Leaflet logic, or print HTML generators except React classNames.

## Design rules

- Light-only, indigo `#4F46E5`, Inter, tabular numbers.
- Cards radius 12, hairline, no `shadow-soft` on content sections.
- Replace remaining `bg-slate-900` action buttons with shared `Button` primary/secondary.
- Replace remaining content `rounded-3xl ... shadow-soft` with `rounded-xl` hairline cards.
- Status as faint tint + border, not saturated slabs.
- Chart colours: `#4F46E5, #2563EB, #0EA5E9, #0F766E, #D97706, #BE123C, #64748B`.
- No new dependencies, no dark mode, no glassmorphism, no card gradients.
- Reuse `FamilyRow` from Phase 2 where a family list is shown on desktop. Keep mobile cards.
- Reuse `Toolbar` / `FilterChip` / `StatCard` / `ReportConfigModal` / `Dialog`.

If Phase 2 did not extract `FamilyRow`, restyle family cards consistently rather than inventing a second row component.

## Page-by-page

### Birthdays — `src/pages/workspace/BirthdaysPage.tsx`

Keep the list. Add a 7-day / 30-day segmented filter **only if it filters the already-loaded `upcoming` list** (no new query). “Today” as a green badge. Call / WhatsApp / SMS as ghost icon buttons. Show count in `PageHeader`. Keep drawer wiring.

### Groups — `src/pages/workspace/GroupsPage.tsx`, `GroupDetailPage.tsx`

Keep tree behaviour. Quiet left-bar / muted header tiles instead of loud sky folder squares. “New Group” = primary `Button`. Sub-group empty: one ghost dashed row. Convert local `bg-slate-900` buttons and `Dialog`-like overlays to shared primitives without changing create/rename/delete/add-member logic. `AddMembersPanel` and `CreateHeaderGroupModal`: visual only.

### Team Leaders cluster

Files: `TeamLeadersPage.tsx`, `UnassignedFamiliesPage.tsx`, `TeamLeaderStatsPage.tsx`, `TeamLeaderDetailPage.tsx`.

- Leader list: table-like rows (name, part, families, voters, actions). Keep search, print, zip, assign modals.
- Unassigned: same family row language as Families desktop; keep assign controls.
- Stats: `StatCard` row + tables, not five stacked `rounded-3xl` sections.
- Detail: profile header (photo, counts, print) then family rows. Collapse repeated tiny `bg-slate-900` buttons into primary Assign + overflow where the same actions remain reachable.
- `TransferFamilyConfirmModal`: use `Dialog` chrome, same confirm logic.

Do not change assignment APIs, special leaders (office/shifted/rented), or PDF builders other than classes.

### Places and Presence notes

`PlacesPage.tsx`, `PresenceNotesPage.tsx`, `PlaceFamilyRoster.tsx`, `PlacePresenceFilters.tsx`, `FamilyWorkbenchRow.tsx`.

Places toolbar is already denser (`h-8`). Align colours and radius to the system. KPI row = `StatCard`. Roster checkboxes and primary actions use shared `Button`. Presence notes: same toolbar/chip language. Do not change URL search-param filter parsing.

### Jobs — `src/pages/workspace/JobsPage.tsx`

Already uses `StatCard`. Align status chips: pending amber, applied blue, appointed green. Filter bar like Voters. Primary actions indigo. Import modal visual only.

### Meetings cluster

`MeetingsPage.tsx`, `MeetingsDetailPage.tsx`, `GlobalNotYetInvitedPage.tsx`, `GlobalNotYetInvitedPartPage.tsx`, `NotInvitedReportModal.tsx`.

- Hub: merge duplicate part filters into one toolbar (part, section, Open meeting, View not invited). Keep navigation targets.
- Progress: five `StatCard`s, not blue/emerald/amber/rose filled slabs.
- Detail: keep family grouping; desktop rows if `FamilyRow` fits, else restyle cards. Attendance as a compact segmented control (Invited / Called / Attended / Absent) **that still calls the same status setters**.
- Not-yet-invited: hairline sections, shared buttons, existing report modal.

Do not change global meeting ensure/fetch or invitee writes.

### Insights and Category Status

`InsightsPage.tsx`, `CategoryStatusPage.tsx`.

- Sticky/shared filter toolbar instead of a giant “Filters” card of nine selects (same state, new layout).
- KPI row = `StatCard` × existing metrics.
- Tables: one chrome (header, print on the right, numeric columns right-aligned tabular). Keep expand/collapse matrix behaviour and click-to-filter.
- Category Status: StatCards per category; desktop family rows; keep assignment select behaviour.

Do not change family aggregation or cache keys.

### Field tools

`FieldGeotagPage.tsx`, `FieldMapPage.tsx`, `LeafletMap.tsx`.

- Treat as tools: large tap targets stay (56px save). Offline / pending pill stays amber.
- Geotag / map: map uses the content column; family picker as a right sheet or stacked panel with radius 12, not another floating `rounded-3xl` card language. Do not change GPS, outbox, or API calls.
- Leaflet layer toggle: indigo/ink instead of `bg-slate-900` if you touch it. Do not change map tiles.

### Booth

`BoothAttendancePage.tsx`, `BoothInsightsPage.tsx`.

- Attendance: search is the product — keep ~52px, autofocus, result list photo + sr no + mark. Keep undo window and outbox. Closed/no-booth alerts as warning-tinted banners (not loud cards).
- Insights: `StatCard`s + simple tables; hourly chart in the new palette if a chart already exists. Keep election/booth query params.

### Admin

`ImportDataPage.tsx`, `UsersPage.tsx`, `WardsPage.tsx`, `BoothConfigPage.tsx`, `CustomFieldsPage.tsx`, `ActivityLogsPage.tsx`.

- Import: style `phaseOrder` as a horizontal stepper (Parse → Confirm → Write → Photos), indigo current step. Keep client-driven chunk loop. If Phase 2 moved Dashboard roll maintenance here, make it a clearly labelled section with danger outline buttons.
- Users: labelled create form; table with role badges (admin indigo, sub-admin slate, user green). Auth UUID as copy-icon, not a raw wide column if easy. Keep admin API calls.
- Wards / Booths / Custom fields: same form + table chrome, shared `Button`.
- Activity: filter toolbar + compact log table; action as badge. Keep 100-row fetch.

### Shared leftovers

Sweep the repo for:

- `bg-slate-900` on **buttons** (not overlays `bg-slate-900/40`)
- Content `rounded-3xl` + `shadow-soft`
- Duplicate modal shells that can use `Dialog` without behaviour change
- Raw “Loading …” text → short skeleton or spinner with existing copy
- `ReportConfigModal` primary still slate-900

Theme `react-hot-toast` if Phase 1 did not.

Empty states: title + one sentence + optional action using `EmptyState` if you add a tiny `src/components/ui/EmptyState.tsx`. No illustration pack.

## Risks

- Meetings attendance segmented control must call the same status update functions.
- Team leader / unassigned assign buttons are easy to drop in a row conversion — keep handlers.
- Insights filter layout must not remount state (`usePersistentState` keys stay).
- Leaflet overflow/radius: change radius only, not height/overflow.
- z-index: Dialog 50, `FloatingDropdown` 9999, do not invert.
- Field-only and booth-agent routes must keep working.
- Do not wire new Settings keys into these pages unless trivial.

## Acceptance criteria

- Every remaining page uses indigo primary, Inter, hairline cards, shared buttons.
- No content-card `shadow-soft` + `rounded-3xl` language left on workspace/admin/field pages.
- Family lists that were restyled still assign / open drawer / call.
- Field attendance mark and geotag save still work.
- Admin import stepper still runs the same parse/commit/photos loop.
- Lint / typecheck pass.

## Out of scope

New features, new charts, dark mode, dependency adds, query/auth/schema changes, rewriting print HTML in `src/lib/reportBuilder.ts` or `leaderFamilyPdf.ts`, deleting `App.css` without confirmation, PWA / service worker.
