-- Run these on the LIVE Supabase Postgres database.
-- They emit CSV that D1 can ingest after light cleanup.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/d1/postgres_export.sql
--
-- Or copy one statement at a time:
--   psql "$DATABASE_URL" -c "\copy (SELECT ...) TO 'exports/voters.csv' CSV HEADER"

-- Directory hint (create first): mkdir -p exports

-- ---------------------------------------------------------------------------
-- Type conversions applied in the SELECT list:
--   uuid            -> text
--   timestamptz     -> ISO-8601 text
--   date            -> YYYY-MM-DD text
--   boolean         -> 0/1 integer
--   int[]           -> JSON array text
--   jsonb           -> JSON text
-- ---------------------------------------------------------------------------

\copy (SELECT
  id::text,
  auth_user_id::text,
  full_name,
  email,
  role::text,
  COALESCE(to_jsonb(allowed_wards)::text, '[]') AS allowed_wards,
  CASE WHEN can_edit THEN 1 ELSE 0 END AS can_edit,
  CASE WHEN password_reset_required THEN 1 ELSE 0 END AS password_reset_required,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
FROM public.users
) TO 'exports/users.csv' CSV HEADER

\copy (SELECT
  id::text,
  epic_no,
  name,
  relative_name,
  relative_relation,
  section_name,
  ward_no,
  part_no,
  section,
  sr_no_roll,
  house_no,
  age,
  to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
  contact_no_1,
  contact_no_2,
  gender,
  religion,
  state,
  voter_category,
  family_head_epic,
  family_label,
  family_color,
  row_color,
  photo_url,
  display_order,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
  updated_by::text
FROM public.voters
) TO 'exports/voters.csv' CSV HEADER

\copy (SELECT
  id::text,
  actor_user_id::text,
  action,
  target_table,
  target_id,
  details::text,
  ip,
  user_agent,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM public.activity_logs
) TO 'exports/activity_logs.csv' CSV HEADER

\copy (SELECT
  id::text,
  file_name,
  storage_path,
  imported_by::text,
  total_rows,
  success_count,
  failed_count,
  error_report::text,
  success_report::text,
  photo_match_report::text,
  duplicate_preview::text,
  status::text,
  progress_phase,
  progress_percent,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM public.import_batches
) TO 'exports/import_batches.csv' CSV HEADER

\copy (SELECT
  id::text,
  name,
  label,
  field_type,
  options::text,
  CASE WHEN required THEN 1 ELSE 0 END AS required,
  CASE WHEN show_in_card THEN 1 ELSE 0 END AS show_in_card,
  CASE WHEN allow_custom_note THEN 1 ELSE 0 END AS allow_custom_note,
  position,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
  updated_by::text
FROM public.custom_fields
) TO 'exports/custom_fields.csv' CSV HEADER

\copy (SELECT
  id::text,
  voter_id::text,
  field_id::text,
  value::text,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
FROM public.custom_field_values
) TO 'exports/custom_field_values.csv' CSV HEADER

\copy (SELECT
  id::text,
  owner_id::text,
  name,
  filters::text,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM public.saved_filter_presets
) TO 'exports/saved_filter_presets.csv' CSV HEADER

\copy (SELECT
  id::text,
  merged_family_key,
  into_family_key,
  merged_voter_ids::text,
  details::text,
  merged_by::text,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM public.family_merge_events
) TO 'exports/family_merge_events.csv' CSV HEADER

-- The following tables are used by the app but are not in supabase/migrations/.
-- If a table is missing, skip that \copy.

\copy (SELECT
  id::text,
  name,
  group_type,
  part_no,
  description,
  created_by::text,
  parent_group_id::text,
  CASE WHEN exclusive_subgroups THEN 1 ELSE 0 END AS exclusive_subgroups,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
FROM public.groups
) TO 'exports/groups.csv' CSV HEADER

\copy (SELECT
  id::text,
  group_id::text,
  voter_id::text,
  added_by::text,
  to_char(added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS added_at
FROM public.group_members
) TO 'exports/group_members.csv' CSV HEADER

\copy (SELECT
  id::text,
  voter_id::text,
  display_name,
  part_no,
  section,
  notes,
  assistant_voter_id::text,
  created_by::text,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
FROM public.team_leaders
) TO 'exports/team_leaders.csv' CSV HEADER

\copy (SELECT
  id::text,
  team_leader_id::text,
  voter_id::text,
  assigned_by::text,
  to_char(assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS assigned_at,
  CASE WHEN is_direct THEN 1 WHEN is_direct IS FALSE THEN 0 ELSE NULL END AS is_direct
FROM public.team_leader_assignments
) TO 'exports/team_leader_assignments.csv' CSV HEADER

\copy (SELECT
  id::text,
  title,
  to_char(meeting_date, 'YYYY-MM-DD') AS meeting_date,
  location,
  part_no,
  notes,
  created_by::text,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM public.meetings
) TO 'exports/meetings.csv' CSV HEADER

\copy (SELECT
  id::text,
  meeting_id::text,
  voter_id::text,
  attendance_status,
  call_note,
  updated_by::text,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
FROM public.meeting_invitees
) TO 'exports/meeting_invitees.csv' CSV HEADER

\copy (SELECT
  id::text,
  voter_id::text,
  status,
  department_name,
  note,
  created_by::text,
  updated_by::text,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
FROM public.job_records
) TO 'exports/job_records.csv' CSV HEADER

-- Auth users (for Better Auth import — emails + hashed passwords if you keep them)
-- Supabase stores hashes in auth.users. Better Auth uses its own hasher, so
-- you typically RECREATE accounts (admin invite / password reset) rather than
-- copy crypt hashes.
\copy (SELECT
  id::text,
  email,
  email_confirmed_at IS NOT NULL AS email_confirmed,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM auth.users
) TO 'exports/auth_users.csv' CSV HEADER
