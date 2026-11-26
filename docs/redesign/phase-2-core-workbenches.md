# Phase 2 — Core workbenches: dashboard, voters, families, settings

You are implementing Phase 2 of the VoterData UI redesign. Phase 1 (tokens, primitives, shell, login) is assumed complete. If Phase 1 primitives (`Button`, `TextField`, `Select`, `Dialog`, restyled `PageHeader`, `StatCard`) are missing, create them first using `docs/redesign/phase-1-foundation.md`, then continue.

This phase is visual layout work on the highest-traffic screens. Do not modify database schemas, Supabase queries, business logic, authentication, permissions, import chunk loops, or print HTML string builders except CSS classes inside React.

Do not start Phase 3.

## Design rules (already in tokens)

- Light-only, indigo `#4F46E5` primary, Inter, tabular numbers.
- Cards: radius 12, hairline border, no `shadow-soft`.
- Controls: 40px desktop, 44px mobile primary.
- Primary buttons: shared `Button` primary (indigo). No new `bg-slate-900` actions on pages you touch.
- Status colour as text + faint fill + 1px border, never saturated slabs.
- Chart series if you touch Dashboard charts: `#4F46E5, #2563EB, #0EA5E9, #0F766E, #D97706, #BE123C, #64748B`. Male/female/other = indigo / sky / slate. If religion colours must be stable, map by label, not pie index.
- No new dependencies, no dark mode, no glassmorphism, no extra gradients on cards.

## 1. Dashboard — `src/pages/workspace/DashboardPage.tsx`

Rebuild the **layout** as a briefing. Keep existing data hooks, report type state, export handlers, and admin guards.

### New structure

1. `PageHeader` title Dashboard, short description.
2. Row of 4 `StatCard`s: Total, Male, Female, Other. Show % of total as `meta`. Featured total card may use the indigo top hairline.
3. Optional “Needs attention” row of link-cards **only if the counts are already available in this page’s data** (do not add new API calls). If unassigned / not-invited / turnout / geotag counts are not on this page, skip this row rather than fetching.
4. Charts: religion donut + legend + count; gender donut + legend; age horizontal/bar with new series colours. Keep Recharts. Click-through to the existing report detail table must keep working.
5. Report controls as a compact toolbar (dimension select, Export Reports, Export Full Backup if admin) — not a fourth chart-sized card.

### Move destructive / admin clutter off the home layout

Admin tools currently on Dashboard: Export All, Part-wise Report, Manage Users, Wards, Import, Activity, Add Missing Voter, Delete All, Delete Part, Disable by EPIC, Bulk Delete by EPIC.

- Keep Export All and Part-wise as secondary toolbar actions if they already live here.
- Add Missing Voter: a secondary button that still `navigate('/voters/new')` — do not duplicate the form.
- **Do not delete the disable/delete handlers in this PR if you cannot land a visible replacement on `/admin/import-data` in the same change.** Either:
  - A) Move the disable/delete/delete-part/delete-all UI blocks to `ImportDataPage.tsx` as a “Roll maintenance” section and leave a Dashboard link “Roll maintenance” → `/admin/import-data`, or
  - B) Collapse them behind an admin-only disclosure titled “Roll maintenance” at the bottom, visually separated, danger buttons as outline until confirm.
- Prefer A if Import page already has disable-by-EPIC (it does). Do not duplicate API calls; move JSX only.

Mobile: keep search (navigates to `/voters?q=`) and shortcut tiles, restyle as a compact 2×3 icon grid using shared card/button styles. Do not add new routes.

Desktop KPI grid must not be `xl:grid-cols-4` with only two cards.

Loading: replace “Loading dashboard...” with a short skeleton or StatCard placeholders. Do not change `load()`.

## 2. Voters — `src/pages/workspace/VotersPage.tsx`

Plus `src/components/voters/VotersTable.tsx`, `VotersCards.tsx`, `VotersByPart.tsx`.

- PageHeader actions: primary Add Voter (admin), secondary Print, secondary Export. Use `Button`.
- One 40px toolbar: search grows, filters share `Select` / native select with one class. Active filters as dismissible chips under the bar on desktop (mobile already has chips).
- Remove or restyle the sky tip banners (“Specific search mode…”, “Rotate mobile to landscape…”) into quiet 12px helper text.
- View switch: one segmented control Card | Table | By Part.
- Honor Settings `defaultView` / `pageSize` / `density` from `localStorage` key `voterdata-ui-settings` if present. Default remains current behaviour when unset (do not surprise users with a new page size).
- Table: Inter 13, denser padding, selected row `brand-50` + 2px indigo left bar. Keep TanStack behaviour, column picker, pagination. Prefer sticky name/photo column if it does not break horizontal scroll.
- Cards: 40px rounded-8 photo (not 48px circle required), sentence-case chips, Call as ghost, Details as quiet text. Keep `onSelectVoter` and `tel:` behaviour.
- Filter sheet (`MobileSheet`): use shared Button for Reset / Apply.
- Recalculate sticky `top-[4.5rem]` if Phase 1 changed header height.

Do not change search matching, custom fields loading, or print field config logic. `ReportConfigModal` visual only.

## 3. Add Voter — `src/pages/workspace/AddVoterPage.tsx`

Visual pass only: 40px controls, photo well radius 12, sticky footer primary = indigo `Button`. Match field chrome to the drawer so create and edit feel like one editor. Do not change upload, EPIC check, or submit.

## 4. Families — `src/pages/workspace/FamiliesPage.tsx`

This file is very large (~5700 lines). Do not refactor business logic. CSS/JSX structure only.

- Toolbar: search + a Filters control that opens desktop popover or existing `MobileSheet`. Stop wrapping 8+ selects in one row.
- Desktop family list: introduce `src/components/families/FamilyRow.tsx` that shows photo, head name, part/section, size, presence, place, leader, actions **using the same buttons and handlers as the current card**. Mobile keeps cards.
- “Family Head” uppercase pill → a 12px “Head” tag beside the name.
- Merge / break / change-head panels: keep behaviour; visually use `Dialog` or the existing in-page panel, not a new workflow.
- Print/export: if this page has a large in-page duplicate of `ReportConfigModal`, hide/replace that block with `ReportConfigModal` **only if** the current confirm callback can be reused unchanged. If wiring is risky, restyle the existing modal chrome and leave the duplicate for Phase 3.
- Replace `bg-slate-900` actions on this page with `Button` primary/secondary.

`FamilyRow` must not drop assign, presence, colour, phone, or drawer-open targets.

Also restyle lightly if you touch them as part of FamilyRow:

- `src/components/families/ClassificationBadges.tsx` — sentence case, 20px height, status colours
- `src/components/families/PresencePicker.tsx` — 36px compact trigger, no logic change

## 5. Voter detail drawer — `src/components/voters/VoterDetailDrawer.tsx`

Visual pass only (file is ~1459 lines). Type, section separators, buttons via `Button`. Do not change save, photo upload, custom fields, or clipboard paste.

## 6. Settings and Profile

- `src/pages/account/SettingsPage.tsx`: labelled `Select`s, hairline cards. **Wire** density / defaultView / pageSize / dateFormat / numberFormat into Voters (and Families density if straightforward). If a setting cannot be wired without risky table changes, leave a short note in the page that it applies to Voters. Add an About block with the Lynvo credit + CC BY-NC-ND 4.0 text removed from the shell in Phase 1.
- `src/pages/account/ProfilePage.tsx`: identity header (initials avatar, name, role badge) + password form using `TextField` / `Button`. Keep change-password API as is.

## 7. Shared extraction for this phase

Create only if it removes duplication you actually touch:

- `src/components/ui/Toolbar.tsx` — search + filters + view switch
- `src/components/ui/FilterChip.tsx` — or reuse `FilterChip` from `src/components/places/PlacePresenceFilters.tsx` without changing Places behaviour
- `src/components/families/FamilyRow.tsx`

Do not rewrite Places in this phase.

## Constraints and risks

- Keep `usePersistentState` keys and filter state. Moving JSX into a sheet must not remount in a way that resets filters.
- Do not change `load()` / cache keys / ward scope.
- Dashboard admin tool move: leave a visible path to disable/delete. Never silently remove those controls.
- Button primitive must keep `disabled` + loading flags (`runningAction`, etc.).
- Do not restyle Groups, Team Leaders, Meetings, Insights, Field, or Admin except token inheritance and any JSX you moved from Dashboard onto Import.

## Acceptance criteria

- Dashboard is a briefing, not an admin junk drawer.
- Voters toolbar + table/cards look like one system; Settings default view/page size apply when set.
- Families desktop uses rows; mobile keeps cards; no lost actions.
- Add Voter and drawer share control chrome.
- License/footer copy lives on Settings.
- Lint / typecheck pass.

## Out of scope for Phase 2

Groups, Group detail, Team Leaders / Unassigned / Stats / Detail, Places, Presence notes, Jobs, Meetings, Insights, Category Status, Birthdays, Field geotag/map, Booth, Admin Users/Wards/Booths/Custom fields/Activity (except Import if you moved roll maintenance), toast copy.
