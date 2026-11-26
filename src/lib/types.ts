export type UserRole = 'admin' | 'sub-admin' | 'user'

export type VoterCategory =
  | 'HOME'
  | 'OPEN'
  | 'AWAY'
  | 'BJP'
  | 'CONGRESS'
  | 'MN_DISCUSSION'
  | 'AWAY_DISCUSSION'

export type PresenceStatus = 'IN_MORMUGAO' | 'OUTSIDE_MORMUGAO' | 'ABROAD'

export interface UserProfile {
  id: string
  auth_user_id: string
  full_name: string | null
  email: string
  role: UserRole
  allowed_wards: number[]
  can_edit: boolean
  created_at?: string
  updated_at?: string
}

export interface Voter {
  id: string
  epic_no: string
  name: string
  relative_name: string | null
  relative_relation: string | null
  section_name: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
  sr_no_roll: number | null
  house_no: string | null
  age: number | null
  date_of_birth: string | null
  contact_no_1: string | null
  contact_no_2: string | null
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null
  religion: string | null
  state: string | null
  voter_category: VoterCategory | null
  family_head_epic: string | null
  family_label: string | null
  family_color: string | null
  row_color: string | null
  photo_url: string | null
  display_order: number | null
  parked_address: string | null
  presence_status: PresenceStatus | null
  presence_note: string | null
  is_active?: boolean | number | null
  disabled_at?: string | null
  disabled_reason?: string | null
  created_at: string
  updated_at: string
}

export type VoterDuplicateMode = 'name_house' | 'name_house_relative' | 'name_relative' | 'name_age_gender' | 'name'

export interface VoterDuplicateGroup {
  key: string
  label: string
  match: VoterDuplicateMode
  voters: Voter[]
}

export interface VoterDuplicateResponse {
  groups: VoterDuplicateGroup[]
  totalGroups: number
  totalVoters: number
  truncated: boolean
  mode: VoterDuplicateMode
  scanned: number
  scanLimited: boolean
}

export interface DisabledVoterRow {
  id: string
  epic_no: string
  name: string
  relative_name: string | null
  relative_relation: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
  section_name: string | null
  house_no: string | null
  age: number | null
  gender: Voter['gender']
  photo_url: string | null
  family_head_epic: string | null
  family_label: string | null
  disabled_at: string | null
  disabled_reason: string | null
  family_key: string | null
  family_head_name: string | null
  family_size: number | null
  team_leader_id: string | null
  team_leader_notes: string | null
  team_leader_display_name: string | null
  team_leader_part_no: number | null
  team_leader_voter_name: string | null
  team_leader_epic_no: string | null
}

export interface NewVoterRow {
  id: string
  epic_no: string
  name: string
  relative_name: string | null
  relative_relation: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
  section_name: string | null
  house_no: string | null
  age: number | null
  gender: Voter['gender']
  photo_url: string | null
  family_head_epic: string | null
  family_label: string | null
  created_at: string
  family_key: string | null
  family_head_name: string | null
  family_size: number | null
  team_leader_id: string | null
  team_leader_notes: string | null
  team_leader_display_name: string | null
  team_leader_part_no: number | null
  team_leader_voter_name: string | null
  team_leader_epic_no: string | null
}

export interface PlaceClub {
  id: string
  area: string
  chawl: string | null
  building: string | null
  created_at: string
  created_by: string | null
}

export interface FamilyPlaceClub {
  family_head_epic: string
  place_club_id: string
  updated_at: string
}

export interface Landlord {
  id: string
  voter_id: string | null
  display_name: string
  house_no: string | null
  contact: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
  notes: string | null
  created_at: string
  created_by: string | null
  updated_at: string
  voter: Voter | null
  tenant_count?: number
}

export interface TenantCounts {
  landlords: number
  tenants: number
  unlinked: number
  onRoll: number
  offRoll: number
}

export interface TenantLink {
  id: string
  landlord_id: string
  tenant_epic: string
  room_no: string | null
  notes: string | null
  created_at: string
  created_by: string | null
  updated_at: string
}

export interface TenantLinkRow extends TenantLink {
  landlord: Landlord
  tenant: Voter
}

export type TenantVoter = Voter & {
  linkId: string
  room_no: string | null
  notes: string | null
}

export interface LandlordGroup {
  landlord: Landlord
  houseNo: string | null
  tenants: TenantVoter[]
}

export interface ShiftedParkingBackupRow {
  id: string
  backed_up_at: string
  parking_kind: 'shifted' | 'single'
  leader_id: string
  leader_notes: string | null
  leader_created_at: string | null
  voter_id: string | null
  epic_no: string | null
  voter_name: string | null
  family_head_epic: string | null
  ward_no: number | null
  part_no: number | null
  section: number | null
  parked_address: string | null
  assignment_id: string | null
  assigned_at: string | null
  assigned_by: string | null
  is_direct: boolean | number | null
  raw_leader_json: unknown
  raw_voter_json: unknown
}

export interface ImportBatch {
  id: string
  file_name: string
  storage_path?: string | null
  status: 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled'
  progress_percent: number
  progress_phase: string
  total_rows: number
  success_count: number
  failed_count: number
  created_at: string
  duplicate_preview: {
    new_count: number
    update_count: number
    duplicate_count: number
    reactivate_count?: number
  } | null
  error_report?: {
    rows?: Array<{ row: number; reason: string }>
    csv?: string
  } | null
  success_report?: {
    rows?: number
    csv?: string
    preview_duplicates?: Array<{
      row: number
      epic_no: string
      match_type: 'exact_duplicate' | 'will_update'
      incoming_name: string
      existing_name: string | null
      incoming_dob: string | null
      existing_dob: string | null
      incoming_contact_no_1: string | null
      existing_contact_no_1: string | null
      incoming_part_no: number | null
      existing_part_no: number | null
      incoming_section: number | null
      existing_section: number | null
      will_reactivate?: boolean
    }>
    preview_duplicates_csv?: string
    new_rows?: number
    update_rows?: number
    unchanged_rows?: number
    reactivate_rows?: number
    new_voters?: Array<{
      epic_no: string
      name: string
      part_no: number | null
      section: number | null
      sr_no_roll: number | null
    }>
    new_voters_csv?: string
  } | null
  photo_match_report?: {
    rows?: Array<{ row: number; epic_no: string; status: string; message?: string }>
    csv?: string
    matched_rows?: number
    total?: number
    queued?: number
    processed?: number
    matched?: number
    failed?: number
  } | null
}

export interface ActivityLog {
  id: string
  actor_user_id: string | null
  action: string
  target_table: string
  target_id: string | null
  details: Record<string, unknown> | null
  ip: string | null
  user_agent: string | null
  created_at: string
}

export interface CustomField {
  id: string
  name: string
  label: string
  field_type: 'text' | 'textarea' | 'number' | 'date' | 'dropdown' | 'multiselect' | 'checkbox' | 'radio'
  options: unknown
  required: boolean
  show_in_card: boolean
  allow_custom_note: boolean
  position: number
}

export type JobStatus = 'applied_govt' | 'applied_private' | 'appointed_govt' | 'appointed_private' | 'pending'

export interface JobRecord {
  id: string
  voter_id: string
  status: JobStatus
  department_name: string | null
  note: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type GroupType = 'part_wise' | 'booth_wise' | 'custom'

export interface Group {
  id: string
  name: string
  group_type: GroupType
  part_no: number | null
  description: string | null
  created_by: string | null
  created_at: string
  updated_at?: string
  // Sub-group support: a group can optionally nest one level under a parent
  // (top-level -> sub-group, no sub-sub-groups). `parent_group_id` is null
  // for top-level groups. `exclusive_subgroups` controls whether a voter can
  // belong to more than one sub-group under the same parent at once - it can
  // be null/undefined on rows created before this column existed, in which
  // case it should be treated as `true` (exclusive), matching the fallback
  // logic already used where this is read.
  parent_group_id: string | null
  exclusive_subgroups: boolean | null
}

export interface GroupMember {
  id: string
  group_id: string
  voter_id: string
  added_by: string | null
  added_at: string
}

export interface TeamLeader {
  id: string
  voter_id: string | null
  display_name: string | null
  part_no: number | null
  section: number | null
  notes: string | null
  assistant_voter_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface TeamLeaderAssignment {
  id: string
  team_leader_id: string
  voter_id: string
  assigned_by: string | null
  assigned_at: string
  is_direct?: boolean | null
}

export type MeetingAttendanceStatus =
  | 'pending'
  | 'called_confirmed'
  | 'called_notreceived'
  | 'called_suspense'
  | 'attended'
  | 'not_attended'
  | 'next_meeting'
  | 'absent'
  | 'called'
  | 'personal_call'

export interface Meeting {
  id: string
  title: string | null
  meeting_date: string
  location: string | null
  part_no: number | null
  notes: string | null
  created_by: string | null
  created_at: string
}

export interface MeetingInvitee {
  id: string
  meeting_id: string
  voter_id: string
  attendance_status: MeetingAttendanceStatus
  call_note: string | null
  updated_by: string | null
  updated_at: string
}

export type ElectionStatus = 'draft' | 'open' | 'closed'

export interface Election {
  id: string
  name: string
  poll_date: string
  status: ElectionStatus
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Booth {
  id: string
  election_id: string
  part_no: number
  section: number | null
  name: string | null
  location: string | null
  created_at: string
}

export interface BoothAgent {
  id: string
  booth_id: string
  user_id: string
  assigned_by: string | null
  assigned_at: string
}

export type TurnoutStatus = 'voted' | 'not_voted'
export type TurnoutSource = 'sr_no' | 'epic' | 'name'

export interface VoterTurnout {
  id: string
  election_id: string
  voter_id: string
  booth_id: string
  status: TurnoutStatus
  marked_at: string
  marked_by: string
  source: TurnoutSource | null
  client_event_id: string
  lat: number | null
  lng: number | null
  override_note: string | null
  overridden_by: string | null
  overridden_at: string | null
}

export interface TeamLeaderUser {
  id: string
  team_leader_id: string
  user_id: string
  assigned_by: string | null
  assigned_at: string
}

export interface FamilyGeotag {
  family_key: string
  lat: number
  lng: number
  accuracy_m: number | null
  altitude: number | null
  tagged_at: string
  tagged_by: string
  team_leader_id: string | null
  source: 'gps' | 'manual'
  note: string | null
  address: string | null
  client_event_id: string
  place_club_id: string | null
  updated_at: string
  head_name?: string | null
  house_no?: string | null
  part_no?: number | null
  section?: number | null
}

export interface FamilyGeotagHistory {
  id: string
  family_key: string
  lat: number
  lng: number
  accuracy_m: number | null
  altitude: number | null
  tagged_at: string
  tagged_by: string | null
  team_leader_id: string | null
  source: string | null
  note: string | null
  address: string | null
  client_event_id: string | null
  place_club_id: string | null
  replaced_at: string
}

export interface TurnoutSummary {
  election_id: string
  total_voters: number
  voted: number
  remaining: number
  turnout_pct: number
  by_part: Array<{ part_no: number | null; voted: number; remaining: number; total: number }>
  by_booth: Array<{ booth_id: string; booth_name: string | null; part_no: number; voted: number }>
  by_section: Array<{ section: number | null; voted: number; remaining: number; total: number }>
  by_gender: Array<{ gender: string; voted: number; remaining: number; total: number }>
  by_age_band: Array<{ band: string; voted: number; remaining: number; total: number }>
  hourly: Array<{ hour: string; count: number }>
  last_marks: Array<{
    voter_id: string
    name: string
    epic_no: string
    sr_no_roll: number | null
    booth_id: string
    marked_at: string
    marked_by_name: string | null
    source: TurnoutSource | null
  }>
}
