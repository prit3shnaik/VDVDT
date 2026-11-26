-- Worker-side SQL that replaces Postgres functions / materialized views.
-- These are not applied as a migration. Call them from the Worker.

-- ===========================================================================
-- refresh_dashboard_stats()
-- Replaces: supabase/migrations/202607040001_initial_schema.sql
-- Call after voter import / bulk delete, NOT on every dashboard page load.
-- ===========================================================================
INSERT INTO dashboard_stats (
  id,
  total_voters,
  male_count,
  female_count,
  other_count,
  avg_age,
  religion_breakdown,
  part_breakdown,
  age_band_breakdown,
  birthday_month_breakdown,
  refreshed_at
)
SELECT
  1,
  COUNT(*),
  SUM(CASE WHEN gender = 'MALE' THEN 1 ELSE 0 END),
  SUM(CASE WHEN gender = 'FEMALE' THEN 1 ELSE 0 END),
  SUM(CASE WHEN gender = 'OTHER' THEN 1 ELSE 0 END),
  COALESCE(AVG(age), 0),
  '{}',
  '{}',
  '{}',
  '{}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM voters
WHERE true
ON CONFLICT(id) DO UPDATE SET
  total_voters = excluded.total_voters,
  male_count = excluded.male_count,
  female_count = excluded.female_count,
  other_count = excluded.other_count,
  avg_age = excluded.avg_age,
  refreshed_at = excluded.refreshed_at;

-- JSON breakdowns cannot be built in one SQLite statement the same way as
-- jsonb_object_agg. Compute them in the Worker from these queries and write
-- the JSON strings back:

-- religion_breakdown
-- SELECT COALESCE(NULLIF(religion, ''), 'UNKNOWN') AS k, COUNT(*) AS c FROM voters GROUP BY 1;

-- part_breakdown
-- SELECT COALESCE(CAST(part_no AS TEXT), 'UNKNOWN') AS k, COUNT(*) AS c FROM voters GROUP BY 1;

-- age_band_breakdown
-- SELECT CASE
--          WHEN age IS NULL THEN 'UNKNOWN'
--          WHEN age BETWEEN 18 AND 25 THEN '18-25'
--          WHEN age BETWEEN 26 AND 35 THEN '26-35'
--          WHEN age BETWEEN 36 AND 50 THEN '36-50'
--          WHEN age BETWEEN 51 AND 65 THEN '51-65'
--          ELSE '66+'
--        END AS k,
--        COUNT(*) AS c
-- FROM voters
-- GROUP BY 1;

-- birthday_month_breakdown
-- SELECT printf('%02d', CAST(strftime('%m', date_of_birth) AS INTEGER)) AS k, COUNT(*) AS c
-- FROM voters
-- WHERE date_of_birth IS NOT NULL
-- GROUP BY 1;

-- ===========================================================================
-- search_voters(p_query, p_limit, p_offset)
-- Prefix query with FTS5: quote user input, append * for prefix match.
-- ===========================================================================
-- SELECT v.*
-- FROM voters v
-- JOIN voters_fts f ON f.rowid = v.rowid
-- WHERE voters_fts MATCH ?
-- LIMIT ? OFFSET ?;

-- ===========================================================================
-- remove_team_leader(p_leader_id)
-- Replaces supabase.rpc('remove_team_leader')
-- ===========================================================================
-- DELETE FROM team_leader_assignments WHERE team_leader_id = ?;
-- DELETE FROM team_leaders WHERE id = ?;

-- ===========================================================================
-- shift_to_office_and_shifted()
-- SQLite has no UPDATE ... FROM. Use two statements.
-- ===========================================================================

-- Singles (family size = 1) -> Office leader
UPDATE team_leader_assignments
SET team_leader_id = (SELECT id FROM team_leaders WHERE notes = '__OFFICE__' LIMIT 1),
    assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE voter_id IN (
  SELECT v.id
  FROM voters v
  JOIN (
    SELECT COALESCE(NULLIF(TRIM(family_head_epic), ''), epic_no) AS fkey
    FROM voters
    GROUP BY COALESCE(NULLIF(TRIM(family_head_epic), ''), epic_no)
    HAVING COUNT(*) = 1
  ) fam ON fam.fkey = COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no)
)
AND team_leader_id IS NOT (
  SELECT id FROM team_leaders WHERE notes = '__OFFICE__' LIMIT 1
);

-- Multi-member families -> Shifted leader
UPDATE team_leader_assignments
SET team_leader_id = (SELECT id FROM team_leaders WHERE notes = '__SHIFTED__' LIMIT 1),
    assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE voter_id IN (
  SELECT v.id
  FROM voters v
  JOIN (
    SELECT COALESCE(NULLIF(TRIM(family_head_epic), ''), epic_no) AS fkey
    FROM voters
    GROUP BY COALESCE(NULLIF(TRIM(family_head_epic), ''), epic_no)
    HAVING COUNT(*) > 1
  ) fam ON fam.fkey = COALESCE(NULLIF(TRIM(v.family_head_epic), ''), v.epic_no)
)
AND team_leader_id IS NOT (
  SELECT id FROM team_leaders WHERE notes = '__SHIFTED__' LIMIT 1
);

-- ===========================================================================
-- meeting_invitees upsert (onConflict: meeting_id, voter_id)
-- ===========================================================================
-- INSERT INTO meeting_invitees (id, meeting_id, voter_id, attendance_status, call_note, updated_by, updated_at)
-- VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
-- ON CONFLICT(meeting_id, voter_id) DO UPDATE SET
--   attendance_status = excluded.attendance_status,
--   call_note = excluded.call_note,
--   updated_by = excluded.updated_by,
--   updated_at = excluded.updated_at;

-- ===========================================================================
-- custom_field_values upsert (onConflict: voter_id, field_id)
-- ===========================================================================
-- INSERT INTO custom_field_values (id, voter_id, field_id, value, updated_at)
-- VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
-- ON CONFLICT(voter_id, field_id) DO UPDATE SET
--   value = excluded.value,
--   updated_at = excluded.updated_at;

-- ===========================================================================
-- Ward-scoped voter list (replaces RLS policy voters_select_by_ward)
-- Bind: ...ward ids..., limit, offset
-- ===========================================================================
-- SELECT * FROM voters
-- WHERE (ward_no IS NULL OR ward_no IN (?, ?))
-- ORDER BY updated_at DESC
-- LIMIT ? OFFSET ?;
