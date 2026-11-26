-- Allow team leaders that are not tied to a voter yet.
-- display_name holds a custom label (e.g. a booth name or placeholder person)
-- until the row is later linked to a real voter via voter_id.

alter table public.team_leaders
  add column if not exists display_name text;

comment on column public.team_leaders.display_name is
  'Custom label for a team leader that is not (yet) a voter. Ignored for Office/Shifted rows.';
