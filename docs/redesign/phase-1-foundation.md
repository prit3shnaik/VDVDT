# Phase 1 — Foundation: tokens, primitives, shell, login

You are implementing Phase 1 of the VoterData UI redesign. This is visual CSS and shared-primitive work only.

Do not start Phase 2 or Phase 3. Do not modify database schemas, Supabase queries, business logic, authentication, permissions, workflows, print HTML generators, or PWA behaviour.

Wait until this phase is complete before considering later work.

## Product context

VoterData is a light-only constituency election intelligence SaaS (React 18 + Vite + Tailwind). The UI currently feels generic because there is no design system: pages independently mix `bg-brand-500` (sky) and `bg-slate-900` primaries, `rounded-2xl` / `rounded-3xl` cards, `shadow-soft` on every surface, and Space Grotesk as the UI font.

Target feel: Linear / Vercel / Stripe. Light-first, indigo accent, quiet surfaces, hairline borders, Inter with tabular numbers. No dark mode, no glassmorphism, no neon, no extra chart libraries, no shadcn, no Framer Motion.

## Design tokens to implement

Replace the current sky brand (`#0284c7`) and Space Grotesk with the system below.

### Colour (`src/index.css` + `tailwind.config.ts`)

- `--bg`: `#F7F8FC` (canvas)
- `--bg-elevated`: `#FFFFFF`
- `--bg-muted`: `#F1F3F9`
- `--bg-sunken`: `#EBEEF6`
- `--ink`: `#0B1220`
- `--ink-secondary`: `#3C4A63`
- `--ink-tertiary`: `#6B7A94`
- `--line`: `#E4E8F1`
- `--line-strong`: `#CDD5E4`
- `--brand-50` / `--accent-50`: `#EEF2FF`
- `--brand-100` / `--accent-100`: `#E0E7FF`
- `--brand-200`: `#C7D2FE`
- `--brand-500` / `--accent-500`: `#4F46E5`
- `--brand-600`: `#4338CA`
- `--brand-700` / `--accent-700`: `#3730A3`

Point existing Tailwind `brand.*` tokens at these indigo values so current `bg-brand-500` usage shifts in one step.

Status (use as text + 6% fill + 1px border, never as saturated card fills):

- Success: text `#047857`, fill `#ECFDF5`, border `#A7F3D0`
- Warning: text `#B45309`, fill `#FFFBEB`, border `#FDE68A`
- Danger: text `#B91C1C`, fill `#FEF2F2`, border `#FECACA`
- Info: text `#1D4ED8`, fill `#EFF6FF`, border `#BFDBFE`

Gradients — two only, never as content-card backgrounds:

1. Login / empty hero wash: `linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 42%, #DBEAFE 100%)`
2. Featured KPI top hairline: `linear-gradient(90deg, #4F46E5, #2563EB)` as a 2px top edge

### Typography

- Body / UI / tables: Inter (`wght@400;500;600;700`), with `font-feature-settings: "tnum"`.
- Space Grotesk may remain on the login wordmark only. Remove it from `body`.
- Page title: 24/28, weight 650, tracking -0.02em
- Section title: 15, weight 600
- Body: 14
- Table: 13, tabular nums
- KPI value: 28/32, tabular nums
- Overline/label: 11, weight 600, tracking 0.04em. Uppercase only for KPI labels, not badges.

### Spacing, radius, shadow

- Control height: 40px default, 36 compact, 44 mobile primary
- Radius control: 8 (`rounded-lg`)
- Radius card: 12 (`rounded-xl`)
- Radius modal: 16 (`rounded-2xl`)
- Stop using `rounded-3xl` on content cards (modals may stay at 16)
- Default card: hairline `border-[--line]`, **no shadow**
- Header / sidebar: `0 1px 0 rgba(15,23,42,0.06)`
- Dropdown / modal: `0 16px 40px rgba(15,23,42,0.12)`
- Retire `shadow-soft` as the universal elevation. Keep the token only if still referenced; do not apply it to every card.

## Files to change

Primary:

- `src/index.css`
- `src/tailwind.config.ts` (path: `tailwind.config.ts` at repo root)
- `index.html` — title `VoterData`, `theme-color` `#4F46E5`
- `src/App.css` — unused Vite leftover; stop importing if imported, otherwise leave unused. Do not delete unless the user confirms.
- `src/app/layouts/AppLayout.tsx`
- `src/pages/auth/LoginPage.tsx`
- `src/components/common/PageHeader.tsx`
- `src/components/common/StatCard.tsx`
- `src/components/common/MobileSheet.tsx`
- `src/components/common/ReportConfigModal.tsx`
- `src/App.tsx` — theme `react-hot-toast` to Inter, radius 8, border `--line`

Create thin primitives (no new dependencies):

- `src/components/ui/Button.tsx` — variants: `primary` | `secondary` | `ghost` | `danger` | `icon`. Sizes 40 default. Must preserve `disabled` / optional `loading`. Primary = indigo 600, white text. This replaces both `bg-brand-500` and `bg-slate-900` for actions you touch in this phase.
- `src/components/ui/TextField.tsx` — labelled 40px input
- `src/components/ui/Select.tsx` — labelled 40px select
- `src/components/ui/Dialog.tsx` — overlay `slate-900/40` + panel radius 16 + modal shadow. Do not rewrite every modal in this phase; build the primitive and use it on Login-adjacent or shell menus only if natural.

Restyle in place (same props, visual only):

- `PageHeader` — 24px title, 14px tertiary description, actions slot ready for `Button`
- `StatCard` — hairline card, 11px label, 28px tabular value, optional indigo top hairline via a prop e.g. `featured`
- `MobileSheet` — top radius 16, themed grab handle
- `ReportConfigModal` — primary confirm button indigo (use `Button`), panel radius 16. Do not change print/export behaviour.

## Shell redesign (`AppLayout.tsx`)

Keep all routes, auth gates, field-only filtering, `moreItemPaths`, and `vote:sidebar-visible` persistence. Visual and grouping only.

Required:

1. Full-height sidebar flush left, ~240px, white, right hairline. Remove the floating rounded island (`rounded-2xl ... shadow-soft` + outer `max-w-[1600px] p-6` chrome). Content area should use the canvas colour and 24px desktop / 16px mobile padding.
2. Wordmark: small indigo mark + “VoterData” in Inter 15/600. Remove the sky billboard block (“Workspace / VoterData”).
3. Group nav labels (do not change paths):
   - Overview: Dashboard, Insights, Category Status
   - Roll: Voters, Families, Birthdays
   - Organisation: Groups, Team Leaders, Places, Jobs
   - Engagement: Meetings
   - Field: Attendance, Booth turnout, Geo-tag, Family map
   - Admin: existing `adminItems` behind existing `isAdminAreaAllowed`
4. Nav item: idle ink-secondary; hover muted fill; active = `brand-50` fill, `brand-700` text, 2px indigo left bar. Not a solid sky pill.
5. Collapse: keep hide/show. Prefer three states if cheap (`expanded | icons | hidden`) stored in the same localStorage key without breaking existing `'false'` handling. If three states add risk, keep boolean hide/show but style the expanded rail as specified.
6. Top bar: current page title derived from the route, optional global search input that navigates to `/voters?q=`, user menu. Remove the static sentence “Constituency voter workspace”. Pending sync as an amber pill, not inline text.
7. Remove the Lynvo / CC license footer from the shell. Do not delete the copy forever — Phase 2/3 will put it on Settings. For this phase, omit it from the layout.
8. Mobile bottom nav: if `fieldOnly`, primary tabs = Attendance, Geo-tag, Map, Turnout (from `fieldItems`). Otherwise Dashboard / Voters / Families / More. Keep the More sheet.
9. Session loading in `RequireAuth` (`src/app/router.tsx`): a simple skeleton, not `p-8 text-sm text-slate-700`.

Update `moreItemPaths` / `mobilePrimaryItems` if grouping changes which items are “more”. Do not break field-only redirect from `/dashboard`.

## Login redesign (`LoginPage.tsx`)

- Split layout: left brand panel with indigo wash + one sentence “Constituency voter intelligence”; right tight labelled form.
- Inputs: labels, 44px, visible focus ring `brand-200`.
- Submit: shared primary `Button`.
- Remove amber/sky decorative orbs.
- Keep existing sign-in fetch logic, toasts, and session redirect.

## Constraints

- No new npm dependencies.
- No dark theme.
- Do not restyle Voters, Families, Dashboard content, Insights, admin pages, or field pages in this phase except where they automatically inherit token changes (`bg-brand-500` remapped to indigo is expected and desired).
- Do not change click handlers, API calls, or form submit logic.
- Preserve `disabled:` styles on any button you convert.
- Recalculate sticky offsets if you change header height (`h-16` + `top-3` is used by Voters mobile search `top-[4.5rem]`). Prefer keeping header at 64px to avoid regressions.

## Acceptance criteria

- Inter is the UI font; indigo is the only primary.
- Sidebar is grouped, flush, quiet active state.
- Login looks like a product sign-in, not a generic card on blobs.
- `PageHeader`, `StatCard`, `Button`, `TextField`, `Select`, `Dialog` exist and are used in the files listed above.
- Field-only users still redirect and still see field nav.
- Admin gate unchanged.
- `npm run lint` / typecheck pass if you touch TSX.

## Out of scope for Phase 1

Dashboard briefing layout, moving delete/disable tools, Voters/Families toolbars, FamilyRow, Insights tables, field maps, admin CRUD, Settings wiring, toast content changes beyond theme.
